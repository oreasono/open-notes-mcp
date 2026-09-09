package server

import (
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalHistoryFixture(t *testing.T) {
	s, rollout := newHistoryFixture(t)
	before := fileHash(t, rollout)

	windowText, err := s.store.historyWindows("target-thread")
	if err != nil {
		t.Fatal(err)
	}
	var summary historySummary
	if err := json.Unmarshal([]byte(windowText), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.SkippedLines != 2 || len(summary.Windows) != 3 {
		t.Fatalf("history_windows = %s", windowText)
	}
	for index, id := range []string{"window-1", "window-2", "window-3"} {
		window := summary.Windows[index]
		if window.Ordinal != index+1 || window.WindowID != id || window.ItemCount == 0 || window.Bytes == 0 || window.FirstTimestamp == "" || window.LastTimestamp == "" {
			t.Fatalf("window %d = %+v", index+1, window)
		}
	}

	searchText, err := s.store.historySearch("target-thread", "earlier sentinel", 0)
	if err != nil {
		t.Fatal(err)
	}
	var search historySearchResult
	if err := json.Unmarshal([]byte(searchText), &search); err != nil {
		t.Fatal(err)
	}
	if len(search.Matches) != 1 || search.Matches[0].Handle != "w1#1" || search.Matches[0].WindowID != "window-1" || search.Matches[0].Kind != "message" {
		t.Fatalf("history_search = %s", searchText)
	}
	if !strings.Contains(search.Matches[0].Snippet, "EARLIER SENTINEL") || len([]byte(search.Matches[0].Snippet)) > maxHistorySnippetBytes {
		t.Fatalf("snippet = %q (%d bytes)", search.Matches[0].Snippet, len([]byte(search.Matches[0].Snippet)))
	}

	assertNoHistoryMatch(t, s.store, "target-thread", "NESTED-ONLY-COPY")
	assertNoHistoryMatch(t, s.store, "target-thread", "CURRENT-ONLY")
	assertHistoryMatch(t, s.store, "target-thread", "FUNCTION-SENTINEL", "w1#2", "function_call")
	assertHistoryMatch(t, s.store, "target-thread", "TOOL-OUTPUT-SENTINEL", "w2#7", "function_call_output")

	readText, err := s.store.historyRead("target-thread", "w1#1", 0, maxHistoryReadBytes)
	if err != nil {
		t.Fatal(err)
	}
	var read historyReadResult
	if err := json.Unmarshal([]byte(readText), &read); err != nil {
		t.Fatal(err)
	}
	if read.Bytes != maxHistoryReadBytes || read.NextOffset == nil || *read.NextOffset != maxHistoryReadBytes || !strings.HasPrefix(read.Text, "EARLIER SENTINEL") {
		t.Fatalf("history_read = %s", readText)
	}
	if strings.Contains(read.Text, `"type":"response_item"`) {
		t.Fatalf("history_read returned the JSONL wrapper: %s", readText)
	}

	hint, err := s.store.hint("target-thread")
	if err != nil || !strings.Contains(hint, "history_search is available for earlier windows of this session") {
		t.Fatalf("hint = %q, err=%v", hint, err)
	}
	if after := fileHash(t, rollout); after != before {
		t.Fatalf("rollout hash changed: %x -> %x", before, after)
	}
}

func TestHistorySearchBudgets(t *testing.T) {
	s, _ := newHistoryFixture(t)
	text, err := s.store.historySearch("target-thread", "BUDGET-MATCH", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len([]byte(text)) > maxHistoryOutputBytes {
		t.Fatalf("history search returned %d bytes", len([]byte(text)))
	}
	var result historySearchResult
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Truncated || result.Notice != historySearchTruncatedText || len(result.Matches) == 0 {
		t.Fatalf("history search truncation = %s", text)
	}
	for _, match := range result.Matches {
		if len([]byte(match.Snippet)) > maxHistorySnippetBytes {
			t.Fatalf("snippet returned %d bytes", len([]byte(match.Snippet)))
		}
	}
}

func TestHistoryReadValidatesHandlesAndUTF8Offsets(t *testing.T) {
	s, _ := newHistoryFixture(t)
	if _, err := s.store.historyRead("target-thread", "w9#9", 0, 10); err == nil {
		t.Fatal("unknown handle unexpectedly succeeded")
	}
	if _, err := s.store.historyRead("target-thread", "w1#3", 1, 10); err == nil || !strings.Contains(err.Error(), "UTF-8") {
		t.Fatalf("mid-rune offset error = %v", err)
	}
	text, err := s.store.historyRead("target-thread", "w1#3", 0, 4)
	if err != nil {
		t.Fatal(err)
	}
	var result historyReadResult
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatal(err)
	}
	if result.Text != "界" || result.Bytes != 3 || result.NextOffset == nil || *result.NextOffset != 3 {
		t.Fatalf("UTF-8 history_read = %s", text)
	}
}

func TestHistoryToolsReturnNonErrorEmptyResults(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.store.historyRoot = t.TempDir()
	for _, call := range []string{
		`{"name":"history_windows","arguments":{},"_meta":{"threadId":"missing"}}`,
		`{"name":"history_search","arguments":{"query":"x"},"_meta":{"threadId":"missing"}}`,
		`{"name":"history_read","arguments":{"handle":"w1#1"},"_meta":{"threadId":"missing"}}`,
	} {
		result := s.handleToolCall(json.RawMessage(call))
		if result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, noHistoryText) {
			t.Fatalf("missing history result = %+v", result)
		}
	}
}

func newHistoryFixture(t *testing.T) (*Server, string) {
	t.Helper()
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	codexHome := t.TempDir()
	s.store.historyRoot = codexHome
	sessions := filepath.Join(codexHome, "sessions", "2026", "09", "09")
	if err := os.MkdirAll(sessions, 0700); err != nil {
		t.Fatal(err)
	}

	writeRollout(t, filepath.Join(sessions, "rollout-0000-other-thread.jsonl"), []string{
		rolloutLineJSON("2026-09-09T00:00:00Z", 0, "session_meta", map[string]interface{}{"context_window": map[string]string{"window_id": "wrong-window"}}),
		rolloutLineJSON("2026-09-09T00:00:01Z", 1, "response_item", messagePayload("WRONG-THREAD EARLIER SENTINEL")),
	})

	longMessage := "EARLIER SENTINEL " + strings.Repeat("a", 5_500)
	lines := []string{
		rolloutLineJSON("2026-09-09T01:00:00Z", 0, "session_meta", map[string]interface{}{"id": "target-thread", "context_window": map[string]string{"window_id": "window-1"}}),
		rolloutLineJSON("2026-09-09T01:00:01Z", 1, "response_item", messagePayload(longMessage)),
		rolloutLineJSON("2026-09-09T01:00:02Z", 2, "response_item", map[string]interface{}{"type": "function_call", "name": "lookup", "arguments": `{"query":"FUNCTION-SENTINEL"}`}),
		rolloutLineJSON("2026-09-09T01:00:03Z", 3, "response_item", messagePayload("界面分页")),
		rolloutLineJSON("2026-09-09T01:00:04Z", 4, "future_rollout_type", map[string]string{"value": "ignored"}),
		`{"timestamp":`,
		rolloutLineJSON("2026-09-09T01:00:06Z", 6, "response_item", messagePayload(strings.Repeat("BUDGET-MATCH a", 120))),
		rolloutLineJSON("2026-09-09T01:00:07Z", 7, "response_item", messagePayload(strings.Repeat("BUDGET-MATCH b", 120))),
		rolloutLineJSON("2026-09-09T01:00:08Z", 8, "response_item", messagePayload(strings.Repeat("BUDGET-MATCH c", 120))),
		rolloutLineJSON("2026-09-09T01:00:09Z", 9, "response_item", messagePayload(strings.Repeat("BUDGET-MATCH d", 120))),
		rolloutLineJSON("2026-09-09T01:00:10Z", 10, "compacted", map[string]interface{}{
			"message":            "",
			"window_number":      1,
			"first_window_id":    "window-1",
			"previous_window_id": "window-1",
			"window_id":          "window-2",
			"replacement_history": []interface{}{
				messagePayload("NESTED-ONLY-COPY"),
			},
		}),
		rolloutLineJSON("2026-09-09T01:00:11Z", 11, "turn_context", map[string]string{"turn_id": "turn-2"}),
		rolloutLineJSON("2026-09-09T01:00:12Z", 7, "response_item", map[string]interface{}{"type": "function_call_output", "output": "TOOL-OUTPUT-SENTINEL"}),
		rolloutLineJSON("2026-09-09T01:00:13Z", 13, "compacted", map[string]interface{}{
			"message":            "",
			"window_number":      2,
			"first_window_id":    "window-1",
			"previous_window_id": "window-2",
			"window_id":          "window-3",
		}),
		rolloutLineJSON("2026-09-09T01:00:14Z", 14, "response_item", messagePayload("EARLIER SENTINEL CURRENT-ONLY")),
	}
	rollout := filepath.Join(sessions, "rollout-9999-target-thread.jsonl")
	writeRollout(t, rollout, lines)
	return s, rollout
}

func messagePayload(text string) map[string]interface{} {
	return map[string]interface{}{
		"type":    "message",
		"role":    "user",
		"content": []map[string]string{{"type": "input_text", "text": text}},
	}
}

func rolloutLineJSON(timestamp string, ordinal int, kind string, payload interface{}) string {
	data, err := json.Marshal(map[string]interface{}{
		"timestamp": timestamp,
		"ordinal":   ordinal,
		"type":      kind,
		"payload":   payload,
	})
	if err != nil {
		panic(err)
	}
	return string(data)
}

func writeRollout(t *testing.T, path string, lines []string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
}

func fileHash(t *testing.T, path string) [sha256.Size]byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(data)
}

func assertNoHistoryMatch(t *testing.T, store *Store, threadID, query string) {
	t.Helper()
	text, err := store.historySearch(threadID, query, 20)
	if err != nil {
		t.Fatal(err)
	}
	var result historySearchResult
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Matches) != 0 {
		t.Fatalf("search %q = %s", query, text)
	}
}

func assertHistoryMatch(t *testing.T, store *Store, threadID, query, handle, kind string) {
	t.Helper()
	text, err := store.historySearch(threadID, strings.ToLower(query), 20)
	if err != nil {
		t.Fatal(err)
	}
	var result historySearchResult
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Matches) != 1 || result.Matches[0].Handle != handle || result.Matches[0].Kind != kind {
		t.Fatalf("search %q = %s; want %s %s", query, text, handle, kind)
	}
}
