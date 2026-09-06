package server

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPathValidationAndWrites(t *testing.T) {
	root := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"./x.md", "a/b/../c.md", "../escape.md", "foo.tmp"} {
		if _, err := s.store.write(name, []byte("x")); err == nil {
			t.Errorf("write(%q) unexpectedly succeeded", name)
		}
	}
	written, err := s.store.write("notes/day1.md", []byte("hello"))
	if err != nil || written != 5 {
		t.Fatalf("write returned %d, %v", written, err)
	}
	data, err := os.ReadFile(filepath.Join(root, "notes", "day1.md"))
	if err != nil || string(data) != "hello" {
		t.Fatalf("stored data = %q, err=%v", data, err)
	}
	mode, err := os.Stat(filepath.Join(root, "notes", "day1.md"))
	if err != nil || mode.Mode().Perm() != 0600 {
		t.Fatalf("file mode = %v, err=%v", mode.Mode().Perm(), err)
	}
}

func TestHintIsBoundedAndStamps(t *testing.T) {
	root := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "INDEX.md"), []byte("marker\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "other.md"), []byte("other"), 0600); err != nil {
		t.Fatal(err)
	}
	hint, err := s.store.hint("thread-1")
	if err != nil || !strings.Contains(hint, "marker\n") || !strings.Contains(hint, "other.md") {
		t.Fatalf("hint = %q, err=%v", hint, err)
	}
	if strings.Contains(hint, "Hint truncated") {
		t.Fatal("small INDEX unexpectedly has a truncation marker")
	}
	if len([]byte(hint)) > maxHintBytes {
		t.Fatalf("hint length = %d", len([]byte(hint)))
	}
	stamp, err := os.ReadFile(filepath.Join(root, ".last-hint"))
	if err != nil || !strings.Contains(string(stamp), "thread_id=thread-1") {
		t.Fatalf("stamp = %q, err=%v", stamp, err)
	}
	if err := os.Remove(filepath.Join(root, "INDEX.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "other.md")); err != nil {
		t.Fatal(err)
	}
	empty, err := s.store.hint("thread-2")
	if err != nil || empty != "" {
		t.Fatalf("empty hint = %q, err=%v", empty, err)
	}
}

func TestLargeIndexHintNamesTheSource(t *testing.T) {
	root := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	large := strings.Repeat("界", 3_000)
	if err := os.WriteFile(filepath.Join(root, "INDEX.md"), []byte(large), 0600); err != nil {
		t.Fatal(err)
	}
	hint, err := s.store.hint("thread-large")
	if err != nil {
		t.Fatal(err)
	}
	if len([]byte(hint)) > maxHintBytes || !strings.Contains(hint, "INDEX.md is too large") || !strings.Contains(hint, "split details") {
		t.Fatalf("large index hint = %q (len=%d)", hint, len([]byte(hint)))
	}
}

func TestOversizeIndexHintNamesTheSource(t *testing.T) {
	root := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "INDEX.md"), []byte(strings.Repeat("x", 1_000_001)), 0600); err != nil {
		t.Fatal(err)
	}
	hint, err := s.store.hint("thread-oversize")
	if err != nil {
		t.Fatal(err)
	}
	if len([]byte(hint)) > maxHintBytes || !strings.Contains(hint, "INDEX.md is too large") || !strings.Contains(hint, "split details") {
		t.Fatalf("oversize index hint = %q (len=%d)", hint, len([]byte(hint)))
	}
}

func TestJSONRPCToolsAndNotifications(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"write_file","arguments":{"path":"x.md","content":"x"}}}`,
	}, "\n") + "\n"
	var output strings.Builder
	if err := s.Serve(strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(strings.NewReader(output.String()))
	var responses []map[string]interface{}
	for scanner.Scan() {
		var response map[string]interface{}
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		responses = append(responses, response)
	}
	if len(responses) != 3 {
		t.Fatalf("responses = %d, want 3", len(responses))
	}
}
