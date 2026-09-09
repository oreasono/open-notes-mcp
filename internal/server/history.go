package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	defaultHistoryLimit        = 20
	defaultHistoryReadBytes    = 1024
	maxHistorySnippetBytes     = 1024
	maxHistoryReadBytes        = 4000
	maxHistoryOutputBytes      = 4000
	noHistoryText              = "no history for this thread"
	historySearchTruncatedText = "[History search truncated; narrow the query or use history_read with a returned handle.]"
)

type historyWindow struct {
	Ordinal        int    `json:"ordinal"`
	WindowID       string `json:"window_id"`
	ItemCount      int    `json:"item_count"`
	Bytes          int    `json:"bytes"`
	FirstTimestamp string `json:"first_timestamp,omitempty"`
	LastTimestamp  string `json:"last_timestamp,omitempty"`
}

type historyItem struct {
	WindowOrdinal int
	Ordinal       uint64
	Kind          string
	Text          string
}

type historyDocument struct {
	Windows      []historyWindow
	Items        []historyItem
	SkippedLines int
}

type historySummary struct {
	Windows      []historyWindow `json:"windows"`
	SkippedLines int             `json:"skipped_lines"`
	Message      string          `json:"message,omitempty"`
}

type historyMatch struct {
	Handle   string `json:"handle"`
	WindowID string `json:"window_id"`
	Kind     string `json:"kind"`
	Snippet  string `json:"snippet"`
}

type historySearchResult struct {
	Matches   []historyMatch `json:"matches"`
	Truncated bool           `json:"truncated"`
	Notice    string         `json:"notice,omitempty"`
	Message   string         `json:"message,omitempty"`
}

type historyReadResult struct {
	Handle     string `json:"handle,omitempty"`
	Offset     int    `json:"offset,omitempty"`
	Bytes      int    `json:"bytes,omitempty"`
	NextOffset *int   `json:"next_offset,omitempty"`
	Text       string `json:"text,omitempty"`
	Message    string `json:"message,omitempty"`
}

func historyJSON(value interface{}) string {
	data, err := json.Marshal(value)
	if err != nil {
		return `{"error":"history result unavailable"}`
	}
	return string(data)
}

func historyReadOptions(args map[string]json.RawMessage) (int, int, error) {
	offset, maxBytes := 0, defaultHistoryReadBytes
	if raw, ok := args["offset"]; ok {
		if err := json.Unmarshal(raw, &offset); err != nil || offset < 0 {
			return 0, 0, errors.New("offset must be a non-negative integer")
		}
	}
	if raw, ok := args["max_bytes"]; ok {
		if err := json.Unmarshal(raw, &maxBytes); err != nil || maxBytes < 1 {
			return 0, 0, errors.New("max_bytes must be a positive integer")
		}
	}
	if maxBytes > maxHistoryReadBytes {
		maxBytes = maxHistoryReadBytes
	}
	return offset, maxBytes, nil
}

func (s *Store) historyWindows(threadID string) (string, error) {
	doc, err := s.history(threadID)
	if err != nil {
		return "", err
	}
	if doc == nil {
		return historyJSON(historySummary{Windows: []historyWindow{}, Message: noHistoryText}), nil
	}
	return historyJSON(historySummary{
		Windows:      doc.Windows,
		SkippedLines: doc.SkippedLines,
	}), nil
}

func (s *Store) historySearch(threadID, query string, limit int) (string, error) {
	doc, err := s.history(threadID)
	if err != nil {
		return "", err
	}
	if doc == nil {
		return historyJSON(historySearchResult{Matches: []historyMatch{}, Message: noHistoryText}), nil
	}
	if limit == 0 {
		limit = defaultHistoryLimit
	}

	result := historySearchResult{Matches: []historyMatch{}}
	currentOrdinal := doc.Windows[len(doc.Windows)-1].Ordinal
	for _, item := range doc.Items {
		if item.WindowOrdinal >= currentOrdinal || !containsFold(item.Text, query) {
			continue
		}
		if len(result.Matches) >= limit {
			result.Truncated = true
			break
		}
		window := doc.window(item.WindowOrdinal)
		if window == nil || window.WindowID == "" {
			continue
		}
		match := historyMatch{
			Handle:   fmt.Sprintf("w%d#%d", item.WindowOrdinal, item.Ordinal),
			WindowID: window.WindowID,
			Kind:     item.Kind,
			Snippet:  historySnippet(item.Text, query, maxHistorySnippetBytes),
		}
		result.Matches = append(result.Matches, match)
		if len([]byte(historyJSON(result))) > maxHistoryOutputBytes {
			result.Matches = result.Matches[:len(result.Matches)-1]
			result.Truncated = true
			break
		}
	}
	if result.Truncated {
		result.Notice = historySearchTruncatedText
		for len([]byte(historyJSON(result))) > maxHistoryOutputBytes && len(result.Matches) > 0 {
			result.Matches = result.Matches[:len(result.Matches)-1]
		}
	}
	return historyJSON(result), nil
}

func (s *Store) historyRead(threadID, handle string, offset, maxBytes int) (string, error) {
	doc, err := s.history(threadID)
	if err != nil {
		return "", err
	}
	if doc == nil {
		return historyJSON(historyReadResult{Message: noHistoryText}), nil
	}
	currentOrdinal := doc.Windows[len(doc.Windows)-1].Ordinal
	var found *historyItem
	for index := range doc.Items {
		item := &doc.Items[index]
		if item.WindowOrdinal >= currentOrdinal {
			continue
		}
		if fmt.Sprintf("w%d#%d", item.WindowOrdinal, item.Ordinal) == handle {
			found = item
			break
		}
	}
	if found == nil {
		return "", errors.New("unknown history handle")
	}
	data := []byte(found.Text)
	if offset > len(data) {
		return "", errors.New("offset exceeds history item")
	}
	if offset < len(data) && !utf8.RuneStart(data[offset]) {
		return "", errors.New("offset must start at a UTF-8 character boundary")
	}
	end := offset + maxBytes
	if end > len(data) {
		end = len(data)
	}
	for end > offset && end < len(data) && !utf8.RuneStart(data[end]) {
		end--
	}
	if end == offset && offset < len(data) {
		return "", errors.New("max_bytes is too small for the next UTF-8 character")
	}
	result := historyReadResult{
		Handle: handle,
		Offset: offset,
		Bytes:  end - offset,
		Text:   string(data[offset:end]),
	}
	if end < len(data) {
		next := end
		result.NextOffset = &next
	}
	return historyJSON(result), nil
}

func (s *Store) history(threadID string) (*historyDocument, error) {
	if threadID == "" {
		return nil, nil
	}
	rollout, err := findRollout(s.historyRoot, threadID)
	if err != nil {
		return nil, err
	}
	if rollout == "" {
		return nil, nil
	}
	file, err := os.Open(rollout)
	if err != nil {
		return nil, fmt.Errorf("open rollout history: %w", err)
	}
	defer file.Close()

	doc := &historyDocument{}
	current := historyWindow{Ordinal: 1}
	reader := bufio.NewReader(file)
	lineOrdinal := uint64(0)
	for {
		raw, readErr := reader.ReadBytes('\n')
		if len(raw) > 0 {
			lineOrdinal++
			physicalBytes := len(raw)
			line := bytes.TrimSuffix(raw, []byte{'\n'})
			line = bytes.TrimSuffix(line, []byte{'\r'})
			// Bytes describe the physical JSONL footprint, including malformed or
			// unknown records that are deliberately skipped from the item count.
			current.Bytes += physicalBytes
			if err := parseHistoryLine(line, lineOrdinal, &current, doc); err != nil {
				doc.SkippedLines++
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			doc.SkippedLines++
			break
		}
	}
	if current.WindowID == "" {
		current.WindowID = fmt.Sprintf("unknown-window-%d", current.Ordinal)
	}
	doc.Windows = append(doc.Windows, current)
	return doc, nil
}

func (d *historyDocument) window(ordinal int) *historyWindow {
	for index := range d.Windows {
		if d.Windows[index].Ordinal == ordinal {
			return &d.Windows[index]
		}
	}
	return nil
}

func findRollout(root, threadID string) (string, error) {
	if root == "" {
		return "", nil
	}
	sessions := filepath.Join(root, "sessions")
	if _, err := os.Stat(sessions); errors.Is(err, os.ErrNotExist) {
		return "", nil
	} else if err != nil {
		return "", fmt.Errorf("inspect Codex sessions: %w", err)
	}
	suffix := "-" + threadID + ".jsonl"
	var matches []string
	err := filepath.WalkDir(sessions, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			return nil
		}
		name := entry.Name()
		if strings.HasPrefix(name, "rollout-") && strings.HasSuffix(name, suffix) {
			matches = append(matches, path)
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("scan Codex sessions: %w", err)
	}
	sort.Strings(matches)
	if len(matches) == 0 {
		return "", nil
	}
	return matches[0], nil
}

type rolloutLine struct {
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp string          `json:"timestamp"`
	Ordinal   json.Number     `json:"ordinal"`
}

func parseHistoryLine(raw []byte, fallbackOrdinal uint64, current *historyWindow, doc *historyDocument) error {
	var line rolloutLine
	if err := json.Unmarshal(raw, &line); err != nil || line.Type == "" || line.Timestamp == "" || len(line.Payload) == 0 || !json.Valid(line.Payload) {
		return errors.New("invalid rollout line")
	}
	ordinal := fallbackOrdinal
	if line.Ordinal != "" {
		parsed, err := strconv.ParseUint(string(line.Ordinal), 10, 64)
		if err != nil {
			return errors.New("rollout line has no valid ordinal")
		}
		ordinal = parsed
	}

	switch line.Type {
	case "session_meta":
		windowID := contextWindowID(line.Payload)
		if windowID != "" && current.WindowID != "" && current.WindowID != windowID {
			return errors.New("session metadata changes context window id")
		}
		if windowID != "" {
			current.WindowID = windowID
		}
		addHistoryLine(current, line.Timestamp)
		return nil
	case "response_item":
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(line.Payload, &payload); err != nil {
			return errors.New("response item has no object payload")
		}
		var kind string
		if err := json.Unmarshal(payload["type"], &kind); err != nil || kind == "" {
			return errors.New("response item has no type")
		}
		addHistoryLine(current, line.Timestamp)
		if text := responseItemText(kind, payload); text != "" {
			doc.Items = append(doc.Items, historyItem{
				WindowOrdinal: current.Ordinal,
				Ordinal:       ordinal,
				Kind:          kind,
				Text:          text,
			})
		}
		return nil
	case "compacted":
		var payload struct {
			WindowNumber            *uint64 `json:"window_number"`
			FirstWindowID           string  `json:"first_window_id"`
			PreviousWindowID        string  `json:"previous_window_id"`
			WindowID                string  `json:"window_id"`
			FirstContextWindowID    string  `json:"first_context_window_id"`
			PreviousContextWindowID string  `json:"previous_context_window_id"`
			ContextWindowID         string  `json:"context_window_id"`
		}
		if err := json.Unmarshal(line.Payload, &payload); err != nil || payload.WindowNumber == nil {
			return errors.New("compacted line is missing window fields")
		}
		firstWindowID := payload.FirstWindowID
		if firstWindowID == "" {
			firstWindowID = payload.FirstContextWindowID
		}
		previousWindowID := payload.PreviousWindowID
		if previousWindowID == "" {
			previousWindowID = payload.PreviousContextWindowID
		}
		windowID := payload.WindowID
		if windowID == "" {
			windowID = payload.ContextWindowID
		}
		if firstWindowID == "" || previousWindowID == "" || windowID == "" {
			return errors.New("compacted line is missing window fields")
		}
		if *payload.WindowNumber != uint64(current.Ordinal) {
			return errors.New("compacted line has an unexpected window number")
		}
		if current.WindowID == "" {
			current.WindowID = previousWindowID
		}
		if current.WindowID != previousWindowID || (current.Ordinal == 1 && current.WindowID != firstWindowID) {
			return errors.New("compacted line does not match the current window")
		}
		addHistoryLine(current, line.Timestamp)
		doc.Windows = append(doc.Windows, *current)
		*current = historyWindow{Ordinal: current.Ordinal + 1, WindowID: windowID}
		return nil
	case "turn_context", "world_state", "event_msg", "inter_agent_communication", "inter_agent_communication_metadata", "security_risk_score", "token_usage_record", "realtime_item":
		addHistoryLine(current, line.Timestamp)
		return nil
	default:
		return errors.New("unknown rollout type")
	}
}

func addHistoryLine(window *historyWindow, timestamp string) {
	window.ItemCount++
	if window.FirstTimestamp == "" {
		window.FirstTimestamp = timestamp
	}
	window.LastTimestamp = timestamp
}

func contextWindowID(raw json.RawMessage) string {
	var payload struct {
		ContextWindow *struct {
			WindowID string `json:"window_id"`
		} `json:"context_window"`
		ContextWindowID string `json:"context_window_id"`
		WindowID        string `json:"window_id"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ""
	}
	if payload.ContextWindow != nil && payload.ContextWindow.WindowID != "" {
		return payload.ContextWindow.WindowID
	}
	if payload.ContextWindowID != "" {
		return payload.ContextWindowID
	}
	return payload.WindowID
}

func responseItemText(kind string, payload map[string]json.RawMessage) string {
	var values []string
	switch kind {
	case "message":
		appendHistoryText(payload["content"], &values)
	case "function_call":
		var name, arguments string
		_ = json.Unmarshal(payload["name"], &name)
		_ = json.Unmarshal(payload["arguments"], &arguments)
		if name != "" {
			values = append(values, name)
		}
		if arguments != "" {
			values = append(values, arguments)
		}
	case "function_call_output":
		appendHistoryText(payload["output"], &values)
	}
	return strings.Join(values, "\n")
}

func appendHistoryText(raw json.RawMessage, output *[]string) {
	var value interface{}
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return
	}
	collectHistoryText(value, output)
}

func collectHistoryText(value interface{}, output *[]string) {
	switch value := value.(type) {
	case string:
		*output = append(*output, value)
	case []interface{}:
		for _, item := range value {
			collectHistoryText(item, output)
		}
	case map[string]interface{}:
		for _, key := range []string{"text", "content", "output"} {
			if item, ok := value[key]; ok {
				collectHistoryText(item, output)
			}
		}
	}
}

func containsFold(text, query string) bool {
	return strings.Contains(strings.ToLower(text), strings.ToLower(query))
}

func historySnippet(text, query string, maxBytes int) string {
	if len([]byte(text)) <= maxBytes {
		return text
	}
	match := strings.Index(strings.ToLower(text), strings.ToLower(query))
	if match < 0 {
		return ""
	}
	start := match - maxBytes/2
	if start < 0 {
		start = 0
	}
	end := start + maxBytes
	if end > len(text) {
		end = len(text)
		start = end - maxBytes
		if start < 0 {
			start = 0
		}
	}
	for start > 0 && !utf8.RuneStart(text[start]) {
		start++
	}
	for end > start && end < len(text) && !utf8.RuneStart(text[end]) {
		end--
	}
	return truncateUTF8(text[start:end], maxBytes)
}

func truncateUTF8(text string, maxBytes int) string {
	data := []byte(text)
	if len(data) <= maxBytes {
		return text
	}
	data = data[:maxBytes]
	for len(data) > 0 && !utf8.Valid(data) {
		data = data[:len(data)-1]
	}
	return string(data)
}
