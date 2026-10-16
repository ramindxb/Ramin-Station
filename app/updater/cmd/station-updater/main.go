package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	updater "stationupdater"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	command := os.Args[1]
	flags := flag.NewFlagSet(command, flag.ExitOnError)
	configPath := flags.String("config", "", "bundled public updater configuration")
	dataRoot := flags.String("data", "", "application data folder")
	target := flags.String("target", "", "current application")
	parent := flags.Int("parent", 0, "parent process ID")
	force := flags.Bool("force", false, "force an update check")
	job := flags.String("job", "", "update receipt ID")
	_ = flags.Parse(os.Args[2:])
	config, err := updater.ReadConfig(*configPath)
	if err != nil {
		fail(err)
	}
	platform := "macos"
	if runtime.GOOS == "windows" {
		platform = "windows"
	}
	manager := &updater.Manager{Config: config, DataRoot: *dataRoot, Platform: platform}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	encode := json.NewEncoder(os.Stdout)
	switch command {
	case "status":
		err = encode.Encode(manager.Status())
	case "check":
		var status updater.Status
		status, err = manager.Check(ctx, *force)
		if err == nil {
			err = encode.Encode(status)
		}
	case "boot", "ack":
		err = manager.Receipt(*job, *target, command == "ack", *parent)
	case "install":
		if *parent <= 0 {
			fail(fmt.Errorf("parent process is required"))
		}
		err = manager.Install(ctx, *target, *parent, func(event updater.Event) {
			if ctx.Err() == nil {
				if writeErr := encode.Encode(event); writeErr != nil {
					cancel()
				}
			}
		}, func() { _ = os.Stdout.Close(); _ = os.Stderr.Close(); signal.Reset(os.Interrupt, syscall.SIGTERM) })
	default:
		err = fmt.Errorf("unknown updater command")
	}
	if err != nil {
		fail(err)
	}
}
func fail(err error) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"error": err.Error(), "time": time.Now().Format(time.RFC3339)})
	os.Exit(1)
}
