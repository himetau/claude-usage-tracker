// usage-server collects Claude usage snapshots from several clients and
// appends them as JSON lines to a single file.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type config struct {
	listenAddr   string
	dataFile     string
	tokens       [][]byte
	maxBodyBytes int64
}

func loadConfig() (config, error) {
	c := config{
		listenAddr:   envOr("LISTEN_ADDR", ":8080"),
		dataFile:     envOr("DATA_FILE", "/data/usage.jsonl"),
		maxBodyBytes: 64 << 10,
	}
	for _, t := range strings.Split(os.Getenv("ACCESS_TOKENS"), ",") {
		if t = strings.TrimSpace(t); t != "" {
			c.tokens = append(c.tokens, []byte(t))
		}
	}
	if len(c.tokens) == 0 {
		return c, errors.New("ACCESS_TOKENS must contain at least one token")
	}
	if v := os.Getenv("MAX_BODY_BYTES"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			return c, errors.New("MAX_BODY_BYTES must be a positive integer")
		}
		c.maxBodyBytes = n
	}
	return c, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// record is one line in the data file. Client is a short, stable hash of the
// access token so entries can be attributed without storing the secret.
type record struct {
	ReceivedAt time.Time       `json:"received_at"`
	Client     string          `json:"client"`
	Data       json.RawMessage `json:"data"`
}

type server struct {
	cfg  config
	mu   sync.Mutex
	file *os.File
}

// authenticate returns the client id for a valid bearer token.
func (s *server) authenticate(r *http.Request) (string, bool) {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || tok == "" {
		return "", false
	}
	valid := 0
	for _, t := range s.cfg.tokens {
		valid |= subtle.ConstantTimeCompare([]byte(tok), t)
	}
	if valid != 1 {
		return "", false
	}
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:4]), true
}

func (s *server) handleUsage(w http.ResponseWriter, r *http.Request) {
	client, ok := s.authenticate(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodPost:
		s.appendUsage(w, r, client)
	case http.MethodGet:
		s.readUsage(w)
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) appendUsage(w http.ResponseWriter, r *http.Request, client string) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.cfg.maxBodyBytes))
	if err != nil {
		http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
		return
	}
	var probe map[string]any
	if err := json.Unmarshal(body, &probe); err != nil {
		http.Error(w, "body must be a JSON object", http.StatusBadRequest)
		return
	}
	line, err := json.Marshal(record{ReceivedAt: time.Now().UTC(), Client: client, Data: body})
	if err != nil {
		http.Error(w, "encode failed", http.StatusInternalServerError)
		return
	}
	line = append(line, '\n')

	s.mu.Lock()
	_, err = s.file.Write(line)
	s.mu.Unlock()
	if err != nil {
		slog.Error("write failed", "err", err)
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) readUsage(w http.ResponseWriter) {
	f, err := os.Open(s.cfg.dataFile)
	if err != nil {
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/x-ndjson")
	io.Copy(w, f)
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe /healthz and exit (for container healthchecks)")
	flag.Parse()

	if *healthcheck {
		addr := envOr("LISTEN_ADDR", ":8080")
		if strings.HasPrefix(addr, ":") {
			addr = "127.0.0.1" + addr
		}
		c := http.Client{Timeout: 3 * time.Second}
		resp, err := c.Get("http://" + addr + "/healthz")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}

	cfg, err := loadConfig()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}
	f, err := os.OpenFile(cfg.dataFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		slog.Error("open data file", "err", err)
		os.Exit(1)
	}
	defer f.Close()

	s := &server{cfg: cfg, file: f}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/usage", s.handleUsage)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	})

	srv := &http.Server{
		Addr:              cfg.listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	slog.Info("listening", "addr", cfg.listenAddr, "data_file", cfg.dataFile, "tokens", len(cfg.tokens))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server", "err", err)
		os.Exit(1)
	}
}
