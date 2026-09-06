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
	if err := s.Serve(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
