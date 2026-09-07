package main

import (
	"fmt"
	"os"

	"github.com/opensource-cio/open-notes-mcp/internal/server"
)

func main() {
	s, err := server.NewFromEnvironment()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if len(os.Args) > 1 {
		if len(os.Args) < 4 || os.Args[1] != "hint" || os.Args[2] != "--source" || os.Args[3] != "claude-code" {
			fmt.Fprintln(os.Stderr, "usage: notes-mcp hint --source claude-code")
			os.Exit(2)
		}
		if len(os.Args) > 4 {
			for _, arg := range os.Args[4:] {
				if arg != "--open-notes-mcp-hook=open-notes-mcp:claude-code" {
					fmt.Fprintln(os.Stderr, "usage: notes-mcp hint --source claude-code")
					os.Exit(2)
				}
			}
		}
		if err := s.HintClaudeCode(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := s.Serve(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
