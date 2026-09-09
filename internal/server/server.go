// Package server implements the notes MCP server and its filesystem-backed
// tools. It deliberately has no network or runtime configuration dependencies.
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
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxFileBytes      int64 = 1_000_000
	maxJSONLineBytes        = 8 * 1024 * 1024
	maxHintBytes            = 4_000
	indexOverflowText       = "[Hint truncated: INDEX.md is too large; split details into partition files and leave pointers in INDEX.md. Use list_files/read_file for remaining notes.]"
)

// Store is the filesystem boundary for the server. The mutex makes an
// append-and-rename operation indivisible when several requests arrive in one
// process.
type Store struct {
	root        string
	historyRoot string
	mu          sync.Mutex
}

// NewFromEnvironment creates a server rooted at AGENT_NOTES_DIR, or at
// ~/.agent-notes when that variable is unset.
func NewFromEnvironment() (*Server, error) {
	root := os.Getenv("AGENT_NOTES_DIR")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("find home directory: %w", err)
		}
		root = filepath.Join(home, ".agent-notes")
	}
	return New(root)
}

// New creates a server rooted at root. The root and all directories it creates
// are private to the current user.
func New(root string) (*Server, error) {
	if root == "" {
		return nil, errors.New("notes root cannot be empty")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve notes root: %w", err)
	}
	if err := os.MkdirAll(abs, 0700); err != nil {
		return nil, fmt.Errorf("create notes root: %w", err)
	}
	if info, err := os.Lstat(abs); err != nil {
		return nil, fmt.Errorf("inspect notes root: %w", err)
	} else if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, errors.New("notes root must be a directory and not a symlink")
	}
	if err := os.Chmod(abs, 0700); err != nil {
		return nil, fmt.Errorf("protect notes root: %w", err)
	}
	historyRoot := os.Getenv("CODEX_HOME")
	if historyRoot == "" {
		home, err := os.UserHomeDir()
		if err == nil {
			historyRoot = filepath.Join(home, ".codex")
		}
	}
	return &Server{store: &Store{root: abs, historyRoot: historyRoot}}, nil
}

// Server is a line-delimited JSON-RPC MCP server.
type Server struct {
	store *Store
}

// HintStamp identifies the delivery channel for a composed hint. Codex uses
// ThreadID; Claude Code uses Source and SessionID.
type HintStamp struct {
	ThreadID  string
	Source    string
	SessionID string
}

// HintClaudeCode consumes a Claude Code SessionStart hook payload and emits
// the hookSpecificOutput envelope expected by Claude Code. Empty hints are
// deliberately silent, while the filesystem stamp is still written.
func (s *Server) HintClaudeCode(input io.Reader, output io.Writer) error {
	var payload struct {
		SessionID string `json:"session_id"`
	}
	decoder := json.NewDecoder(input)
	if err := decoder.Decode(&payload); err != nil {
		return fmt.Errorf("read Claude Code hook input: %w", err)
	}
	hint, err := s.store.hintWithStamp(HintStamp{Source: "claude-code", SessionID: payload.SessionID})
	if err != nil {
		return err
	}
	if hint == "" {
		return nil
	}
	response := map[string]interface{}{
		"hookSpecificOutput": map[string]string{
			"hookEventName":     "SessionStart",
			"additionalContext": hint,
		},
	}
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(response)
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type textContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type toolResult struct {
	Content []textContent `json:"content"`
	IsError bool          `json:"isError,omitempty"`
}

type callParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Meta      struct {
		ThreadID string `json:"threadId"`
	} `json:"_meta"`
}

// Serve reads requests until stdin closes. Notifications (requests without an
// id) are processed but never produce a response, as required by JSON-RPC.
func (s *Server) Serve(input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64*1024), maxJSONLineBytes)
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		response, notification := s.handle(line)
		if notification {
			continue
		}
		if err := encoder.Encode(response); err != nil {
			return fmt.Errorf("write response: %w", err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read JSON-RPC input: %w", err)
	}
	return nil
}

func (s *Server) handle(line []byte) (rpcResponse, bool) {
	var request rpcRequest
	if err := json.Unmarshal(line, &request); err != nil {
		return rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "parse error"}}, false
	}
	notification := len(request.ID) == 0
	if request.JSONRPC != "2.0" || request.Method == "" {
		if notification {
			return rpcResponse{}, true
		}
		return rpcResponse{JSONRPC: "2.0", ID: responseID(request.ID), Error: &rpcError{Code: -32600, Message: "invalid request"}}, false
	}

	if request.Method == "notifications/initialized" || strings.HasPrefix(request.Method, "notifications/") {
		return rpcResponse{}, true
	}
	var result interface{}
	var rpcErr *rpcError
	switch request.Method {
	case "initialize":
		result = initializeResult()
	case "tools/list":
		result = map[string]interface{}{"tools": toolDefinitions()}
	case "tools/call":
		result = s.handleToolCall(request.Params)
	default:
		rpcErr = &rpcError{Code: -32601, Message: "method not found"}
	}
	if notification {
		return rpcResponse{}, true
	}
	return rpcResponse{JSONRPC: "2.0", ID: responseID(request.ID), Result: result, Error: rpcErr}, false
}

func responseID(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return raw
}

func initializeResult() map[string]interface{} {
	return map[string]interface{}{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]interface{}{"tools": map[string]interface{}{}},
		"serverInfo":      map[string]interface{}{"name": "notes", "version": "0.1.0"},
	}
}

func toolDefinitions() []map[string]interface{} {
	object := func(properties map[string]interface{}, required []string) map[string]interface{} {
		schema := map[string]interface{}{"type": "object", "properties": properties, "additionalProperties": false}
		if required != nil {
			schema["required"] = required
		}
		return schema
	}
	pathProperty := map[string]interface{}{"type": "string", "description": "Relative path under the notes directory; empty, ., .., and .tmp paths are rejected."}
	contentProperty := map[string]interface{}{"type": "string", "description": "UTF-8 content. A single file may be at most 1000000 bytes."}
	return []map[string]interface{}{
		{"name": "read_file", "description": "Read a note file from the notes directory.", "inputSchema": object(map[string]interface{}{"path": pathProperty}, []string{"path"})},
		{"name": "write_file", "description": "Replace a note file atomically. Reports the actual bytes written; files are limited to 1000000 bytes.", "inputSchema": object(map[string]interface{}{"path": pathProperty, "content": contentProperty}, []string{"path", "content"})},
		{"name": "append_to_file", "description": "Append to a note file atomically. Reports bytes appended; files are limited to 1000000 bytes.", "inputSchema": object(map[string]interface{}{"path": pathProperty, "content": contentProperty}, []string{"path", "content"})},
		{"name": "list_files", "description": "List note files newest first with sizes and RFC3339 modification times.", "inputSchema": object(map[string]interface{}{"prefix": map[string]interface{}{"type": "string", "description": "Optional relative path prefix."}}, nil)},
		{"name": "search", "description": "Case-insensitive substring search across note files; returns path:line: text matches.", "inputSchema": object(map[string]interface{}{"query": map[string]interface{}{"type": "string"}}, []string{"query"})},
		{"name": "history_windows", "description": "Summarize earlier local Codex context windows for this thread.", "inputSchema": object(map[string]interface{}{}, nil)},
		{"name": "history_search", "description": "Search message and tool-call text in earlier local Codex context windows.", "inputSchema": object(map[string]interface{}{"query": map[string]interface{}{"type": "string"}, "limit": map[string]interface{}{"type": "integer", "minimum": 1}}, []string{"query"})},
		{"name": "history_read", "description": "Read a bounded original history item by its history_search handle.", "inputSchema": object(map[string]interface{}{"handle": map[string]interface{}{"type": "string"}, "offset": map[string]interface{}{"type": "integer", "minimum": 0}, "max_bytes": map[string]interface{}{"type": "integer", "minimum": 1}}, []string{"handle"})},
	}
}

func (s *Server) handleToolCall(raw json.RawMessage) toolResult {
	var params callParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil || params.Name == "" {
		return errorResult("invalid tools/call parameters")
	}
	switch params.Name {
	case "read_file":
		args, err := decodeObject(params.Arguments, false)
		if err != nil {
			return errorResult(err.Error())
		}
		path, err := requiredString(args, "path")
		if err != nil {
			return errorResult(err.Error())
		}
		if err := rejectUnknown(args, "path"); err != nil {
			return errorResult(err.Error())
		}
		content, err := s.store.read(path)
		if err != nil {
			return errorResult(err.Error())
		}
		return textResult(string(content))
	case "write_file", "append_to_file":
		args, err := decodeObject(params.Arguments, false)
		if err != nil {
			return errorResult(err.Error())
		}
		path, err := requiredString(args, "path")
		if err != nil {
			return errorResult(err.Error())
		}
		content, err := requiredString(args, "content")
		if err != nil {
			return errorResult(err.Error())
		}
		if err := rejectUnknown(args, "path", "content"); err != nil {
			return errorResult(err.Error())
		}
		var written int
		if params.Name == "write_file" {
			written, err = s.store.write(path, []byte(content))
		} else {
			written, err = s.store.append(path, []byte(content))
		}
		if err != nil {
			return errorResult(err.Error())
		}
		return textResult(fmt.Sprintf("bytes_written=%d path=%s", written, path))
	case "list_files":
		args, err := decodeObject(params.Arguments, true)
		if err != nil {
			return errorResult(err.Error())
		}
		if err := rejectUnknown(args, "prefix"); err != nil {
			return errorResult(err.Error())
		}
		prefix := ""
		if rawPrefix, ok := args["prefix"]; ok {
			if string(rawPrefix) == "null" {
				return errorResult("prefix must be a string")
			}
			if err := json.Unmarshal(rawPrefix, &prefix); err != nil {
				return errorResult("prefix must be a string")
			}
		}
		lines, err := s.store.list(prefix)
		if err != nil {
			return errorResult(err.Error())
		}
		return textResult(strings.Join(lines, "\n"))
	case "search":
		args, err := decodeObject(params.Arguments, false)
		if err != nil {
			return errorResult(err.Error())
		}
		query, err := requiredString(args, "query")
		if err != nil {
			return errorResult(err.Error())
		}
		if err := rejectUnknown(args, "query"); err != nil {
			return errorResult(err.Error())
		}
		lines, err := s.store.search(query)
		if err != nil {
			return errorResult(err.Error())
		}
		return textResult(strings.Join(lines, "\n"))
	case "thread_hint":
		if err := validateHintArguments(params.Arguments); err != nil {
			return errorResult(err.Error())
		}
		hint, err := s.store.hint(params.Meta.ThreadID)
		if err != nil {
			return errorResult(err.Error())
		}
		if hint == "" {
			return toolResult{Content: []textContent{}}
		}
		return textResult(hint)
	case "history_windows":
		args, err := decodeObject(params.Arguments, true)
		if err != nil {
			return errorResult(err.Error())
		}
		if err := rejectUnknown(args); err != nil {
			return errorResult(err.Error())
		}
		result, err := s.store.historyWindows(params.Meta.ThreadID)
		if err != nil {
			return errorResult(err.Error())
		}
		return textResult(result)
	case "history_search":
		args, err := decodeObject(params.Arguments, false)
		if err != nil {
			return errorResult(err.Error())
		}
		query, err := requiredString(args, "query")
		if err != nil {
			return errorResult(err.Error())
		}
		if err := rejectUnknown(args, "query", "limit"); err != nil {
			return errorResult(err.Error())
		}
		limit := 0
		if rawLimit, ok := args["limit"]; ok {
			if err := json.Unmarshal(rawLimit, &limit); err != nil || limit < 1 {
				return errorResult("limit must be a positive integer")
			}
		}
		result, err := s.store.historySearch(params.Meta.ThreadID, query, limit)
		if err != nil {
			return errorResult(err.Error())
		}
		return textResult(result)
	case "history_read":
		args, err := decodeObject(params.Arguments, false)
		if err != nil {
			return errorResult(err.Error())
		}
		handle, err := requiredString(args, "handle")
		if err != nil {
			return errorResult(err.Error())
		}
		if err := rejectUnknown(args, "handle", "offset", "max_bytes"); err != nil {
			return errorResult(err.Error())
		}
		offset, maxBytes, err := historyReadOptions(args)
		if err != nil {
			return errorResult(err.Error())
		}
		result, err := s.store.historyRead(params.Meta.ThreadID, handle, offset, maxBytes)
		if err != nil {
			return errorResult(err.Error())
		}
		return textResult(result)
	default:
		return errorResult("unknown tool: " + params.Name)
	}
}

func decodeObject(raw json.RawMessage, allowMissing bool) (map[string]json.RawMessage, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		if allowMissing {
			return map[string]json.RawMessage{}, nil
		}
		return nil, errors.New("arguments must be an object")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, errors.New("arguments must be an object")
	}
	return object, nil
}

func validateHintArguments(raw json.RawMessage) error {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	args, err := decodeObject(raw, false)
	if err != nil {
		return err
	}
	return rejectUnknown(args)
}

func requiredString(args map[string]json.RawMessage, name string) (string, error) {
	raw, ok := args[name]
	if !ok {
		return "", fmt.Errorf("missing required argument: %s", name)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", name)
	}
	return value, nil
}

func rejectUnknown(args map[string]json.RawMessage, allowed ...string) error {
	set := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		set[key] = struct{}{}
	}
	for key := range args {
		if _, ok := set[key]; !ok {
			return fmt.Errorf("unknown argument: %s", key)
		}
	}
	return nil
}

func textResult(text string) toolResult {
	return toolResult{Content: []textContent{{Type: "text", Text: text}}}
}

func errorResult(message string) toolResult {
	return toolResult{Content: []textContent{{Type: "text", Text: message}}, IsError: true}
}

type fileEntry struct {
	rel   string
	size  int64
	mtime time.Time
}

func (s *Store) read(name string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.resolve(name, false)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("read %q: %w", name, err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("read %q: not a regular file", name)
	}
	if info.Size() > maxFileBytes {
		return nil, fmt.Errorf("file exceeds %d byte limit", maxFileBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %q: %w", name, err)
	}
	return data, nil
}

func (s *Store) write(name string, data []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if int64(len(data)) > maxFileBytes {
		return 0, fmt.Errorf("file exceeds %d byte limit", maxFileBytes)
	}
	if _, err := s.resolve(name, true); err != nil {
		return 0, err
	}
	if err := s.writeAtomicLocked(name, data); err != nil {
		return 0, err
	}
	return len(data), nil
}

func (s *Store) append(name string, data []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if int64(len(data)) > maxFileBytes {
		return 0, fmt.Errorf("file exceeds %d byte limit", maxFileBytes)
	}
	path, err := s.resolve(name, true)
	if err != nil {
		return 0, err
	}
	if info, statErr := os.Stat(path); statErr == nil && (!info.Mode().IsRegular() || info.Size() > maxFileBytes) {
		return 0, fmt.Errorf("file exceeds %d byte limit or is not regular", maxFileBytes)
	}
	old, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return 0, fmt.Errorf("read %q for append: %w", name, err)
	}
	if int64(len(old))+int64(len(data)) > maxFileBytes {
		return 0, fmt.Errorf("file exceeds %d byte limit", maxFileBytes)
	}
	combined := make([]byte, 0, len(old)+len(data))
	combined = append(combined, old...)
	combined = append(combined, data...)
	if err := s.writeAtomicLocked(name, combined); err != nil {
		return 0, err
	}
	return len(data), nil
}

func (s *Store) list(prefix string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := s.listLocked(prefix)
	if err != nil {
		return nil, err
	}
	lines := make([]string, 0, len(entries))
	for _, entry := range entries {
		lines = append(lines, fmt.Sprintf("%s (%d bytes, %s)", entry.rel, entry.size, entry.mtime.UTC().Format(time.RFC3339)))
	}
	return lines, nil
}

func (s *Store) listLocked(prefix string) ([]fileEntry, error) {
	if prefix != "" {
		if _, err := validatePath(prefix); err != nil {
			return nil, fmt.Errorf("invalid prefix: %w", err)
		}
	}
	var entries []fileEntry
	err := filepath.WalkDir(s.root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == s.root {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if strings.HasSuffix(name, ".tmp") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(s.root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if prefix != "" && rel != prefix && !strings.HasPrefix(rel, prefix+"/") {
			return nil
		}
		entries = append(entries, fileEntry{rel: rel, size: info.Size(), mtime: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list notes: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].mtime.Equal(entries[j].mtime) {
			return entries[i].rel < entries[j].rel
		}
		return entries[i].mtime.After(entries[j].mtime)
	})
	return entries, nil
}

func (s *Store) search(query string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := s.listLocked("")
	if err != nil {
		return nil, err
	}
	needle := strings.ToLower(query)
	var matches []string
	for _, entry := range entries {
		path := filepath.Join(s.root, filepath.FromSlash(entry.rel))
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("search %q: %w", entry.rel, err)
		}
		for number, line := range strings.Split(string(data), "\n") {
			if strings.Contains(strings.ToLower(line), needle) {
				matches = append(matches, fmt.Sprintf("%s:%d: %s", entry.rel, number+1, strings.TrimSuffix(line, "\r")))
			}
		}
	}
	return matches, nil
}

func (s *Store) hint(threadID string) (string, error) {
	return s.hintWithStamp(HintStamp{ThreadID: threadID})
}

func (s *Store) hintWithStamp(stamp HintStamp) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := s.listLocked("")
	if err != nil {
		return "", err
	}
	historyAvailable := false
	if doc, historyErr := s.history(stamp.ThreadID); historyErr == nil {
		historyAvailable = doc != nil && len(doc.Windows) > 1
	}
	if len(entries) == 0 && !historyAvailable {
		s.stampLocked(stamp, 0)
		return "", nil
	}
	var b strings.Builder
	indexOverflow := false
	if len(entries) > 0 {
		b.WriteString("Notes you wrote in earlier context windows of this session.\nRead any file below with the notes read_file tool.\n\n")
		indexPath := filepath.Join(s.root, "INDEX.md")
		if info, statErr := os.Lstat(indexPath); statErr == nil && info.Mode().IsRegular() {
			if info.Size() > maxFileBytes {
				indexOverflow = true
				b.WriteString("--- INDEX.md ---\n")
				b.WriteString(indexOverflowText)
				b.WriteString("\n\n")
			} else {
				data, readErr := os.ReadFile(indexPath)
				if readErr != nil {
					return "", fmt.Errorf("read INDEX.md: %w", readErr)
				}
				b.WriteString("--- INDEX.md ---\n")
				indexText := normalizeTrailingNewline(data)
				b.WriteString(indexText)
				b.WriteString("\n")
				indexOverflow = len([]byte(indexText)) > maxHintBytes-len([]byte("Notes you wrote in earlier context windows of this session.\nRead any file below with the notes read_file tool.\n\n--- INDEX.md ---\n\n--- other notes ---\n"))
			}
		}
		b.WriteString("--- other notes ---\n")
		for _, entry := range entries {
			if entry.rel == "INDEX.md" {
				continue
			}
			b.WriteString(fmt.Sprintf("%s (%d bytes, %s)\n", entry.rel, entry.size, entry.mtime.UTC().Format(time.RFC3339)))
		}
	}
	if historyAvailable {
		b.WriteString("history_search is available for earlier windows of this session\n")
	}
	hint := truncateHint(b.String(), indexOverflow)
	s.stampLocked(stamp, len([]byte(hint)))
	return hint, nil
}

func normalizeTrailingNewline(data []byte) string {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.TrimRight(text, "\n")
	return text + "\n"
}

func truncateHint(hint string, indexOverflow bool) string {
	if len([]byte(hint)) <= maxHintBytes {
		return hint
	}
	marker := "\n[Hint truncated; use list_files/read_file for remaining notes.]\n"
	if indexOverflow {
		marker = "\n" + indexOverflowText + "\n"
	}
	limit := maxHintBytes - len([]byte(marker))
	if limit < 0 {
		return marker[:maxHintBytes]
	}
	data := []byte(hint[:limit])
	for len(data) > 0 && !utf8.Valid(data) {
		data = data[:len(data)-1]
	}
	return string(data) + marker
}

func (s *Store) stampLocked(stamp HintStamp, bytesCount int) {
	line := fmt.Sprintf("last_thread_hint=%s", time.Now().UTC().Format(time.RFC3339))
	if stamp.Source != "" {
		line += fmt.Sprintf(" source=%s session_id=%s", stamp.Source, stamp.SessionID)
	} else {
		line += fmt.Sprintf(" thread_id=%s", stamp.ThreadID)
	}
	line += fmt.Sprintf(" bytes=%d\n", bytesCount)
	_ = s.writeAtomicLocked(".last-hint", []byte(line))
}

func (s *Store) writeAtomicLocked(name string, data []byte) error {
	target, err := s.resolve(name, true)
	if err != nil {
		return err
	}
	parent := filepath.Dir(target)
	base := filepath.Base(target)
	tmp, err := os.CreateTemp(parent, "."+base+"-*.tmp")
	if err != nil {
		return fmt.Errorf("stage %q: %w", name, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("protect staged %q: %w", name, err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write %q: %w", name, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync %q: %w", name, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close %q: %w", name, err)
	}
	if err := os.Rename(tmpName, target); err != nil {
		return fmt.Errorf("commit %q: %w", name, err)
	}
	return os.Chmod(target, 0600)
}

func (s *Store) resolve(name string, createParents bool) (string, error) {
	components, err := validatePath(name)
	if err != nil {
		return "", err
	}
	current := s.root
	for i, component := range components {
		current = filepath.Join(current, component)
		info, statErr := os.Lstat(current)
		if statErr != nil {
			if !errors.Is(statErr, os.ErrNotExist) {
				return "", fmt.Errorf("inspect path %q: %w", name, statErr)
			}
			if createParents && i < len(components)-1 {
				if err := os.Mkdir(current, 0700); err != nil && !errors.Is(err, os.ErrExist) {
					return "", fmt.Errorf("create parent for %q: %w", name, err)
				}
				if err := os.Chmod(current, 0700); err != nil {
					return "", fmt.Errorf("protect parent for %q: %w", name, err)
				}
				continue
			}
			if i == len(components)-1 {
				return current, nil
			}
			return "", fmt.Errorf("path does not exist: %s", name)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("symlinks are not allowed in path: %s", name)
		}
		if i < len(components)-1 && !info.IsDir() {
			return "", fmt.Errorf("path component is not a directory: %s", component)
		}
	}
	return current, nil
}

func validatePath(name string) ([]string, error) {
	if name == "" {
		return nil, errors.New("path cannot be empty")
	}
	if filepath.IsAbs(name) || strings.IndexByte(name, 0) >= 0 || strings.ContainsRune(name, '\\') {
		return nil, errors.New("path must be relative")
	}
	if strings.HasSuffix(name, ".tmp") {
		return nil, errors.New(".tmp paths are reserved")
	}
	parts := strings.Split(name, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, errors.New("path contains an empty, . or .. component")
		}
	}
	return parts, nil
}
