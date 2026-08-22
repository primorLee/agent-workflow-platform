// Package config loads and validates the agent's YAML configuration.
//
// Precedence (highest wins):
//  1. Environment variables (AWP_AGENT_*)
//  2. YAML file at --config path
//  3. Built-in defaults
//
// No secret is ever compiled into the binary. api_key must come from the
// config file (chmod 0600) or AWP_AGENT_API_KEY env. systemd installs
// may use LoadCredential=.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the resolved agent configuration.
type Config struct {
	// ServerURL — broker entry point, e.g. "ws://127.0.0.1:8100/agent/connect".
	// Must be wss:// in production. Plain ws:// is accepted only when its
	// host is exactly localhost or an IP literal in a loopback range.
	ServerURL string `yaml:"server_url"`

	// APIKey — opaque bearer token minted by the control plane. Never logged.
	APIKey string `yaml:"api_key"`

	// AgentName — stable identifier shown in the UI. Defaults to hostname.
	AgentName string `yaml:"agent_name"`

	// WorkDir — where task sandboxes, crash dumps, and the self-update
	// staging area live. Must be writable by the agent user.
	WorkDir string `yaml:"work_dir"`

	// LogFile — if set and --daemon is passed, JSON logs rotate here
	// (lumberjack). Empty means stderr only.
	LogFile string `yaml:"log_file"`

	// LogLevel — debug | info | warn | error. Default info.
	LogLevel string `yaml:"log_level"`

	// MaxConcurrentTasks — how many tasks the broker is allowed to dispatch
	// to this agent at once. Default 2; bump for big hosts.
	MaxConcurrentTasks int `yaml:"max_concurrent_tasks"`

	// HeartbeatInterval — how often the agent sends a heartbeat envelope
	// once the connection is authenticated. Broker closes the socket if it
	// doesn't see one for 3× this duration.
	HeartbeatInterval time.Duration `yaml:"heartbeat_interval"`

	// ShutdownTimeout — SIGTERM → drain deadline. Tasks get a SIGTERM then
	// SIGKILL if they don't exit in time. Default 60s.
	ShutdownTimeout time.Duration `yaml:"shutdown_timeout"`

	// TLSCertPin — optional SHA-256 pin of the broker leaf certificate.
	// Hex-encoded, e.g. "a1b2...". Empty means standard system trust.
	// Useful for regulated deployments that want belt-and-braces.
	TLSCertPin string `yaml:"tls_cert_pin"`

	// HTTPSProxy — explicit proxy override. If empty the dialer falls back
	// to the HTTPS_PROXY / https_proxy environment variables.
	HTTPSProxy string `yaml:"https_proxy"`
}

// Load reads path, applies env overrides, fills defaults, and validates.
// If path doesn't exist but every required field is supplied via env, that's
// fine — useful for container deployments.
func Load(path string) (*Config, error) {
	cfg := &Config{}

	if path != "" {
		raw, err := os.ReadFile(path)
		switch {
		case err == nil:
			if err := yaml.Unmarshal(raw, cfg); err != nil {
				return nil, fmt.Errorf("parse %s: %w", path, err)
			}
		case errors.Is(err, os.ErrNotExist):
			// fine — fall through, env may fill in
		default:
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
	}

	applyEnv(cfg)
	applyDefaults(cfg)

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func applyEnv(c *Config) {
	if v := os.Getenv("AWP_AGENT_SERVER_URL"); v != "" {
		c.ServerURL = v
	}
	if v := os.Getenv("AWP_AGENT_API_KEY"); v != "" {
		c.APIKey = v
	}
	if v := os.Getenv("AWP_AGENT_NAME"); v != "" {
		c.AgentName = v
	}
	if v := os.Getenv("AWP_AGENT_WORK_DIR"); v != "" {
		c.WorkDir = v
	}
	if v := os.Getenv("AWP_AGENT_LOG_FILE"); v != "" {
		c.LogFile = v
	}
	if v := os.Getenv("AWP_AGENT_LOG_LEVEL"); v != "" {
		c.LogLevel = v
	}
	if v := os.Getenv("AWP_AGENT_MAX_CONCURRENT_TASKS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.MaxConcurrentTasks = n
		}
	}
	if v := os.Getenv("AWP_AGENT_HEARTBEAT_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			c.HeartbeatInterval = d
		}
	}
	if v := os.Getenv("AWP_AGENT_SHUTDOWN_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			c.ShutdownTimeout = d
		}
	}
	if v := os.Getenv("AWP_AGENT_TLS_CERT_PIN"); v != "" {
		c.TLSCertPin = v
	}
	// HTTPSProxy is intentionally *not* overridden from AWP_AGENT_HTTPS_PROXY
	// unless the user explicitly set it in YAML; the dialer will fall back to
	// HTTPS_PROXY from the standard Go environment.
}

func applyDefaults(c *Config) {
	if c.ServerURL == "" {
		c.ServerURL = "ws://127.0.0.1:8100/agent/connect"
	}
	if c.AgentName == "" {
		if hn, err := os.Hostname(); err == nil {
			c.AgentName = hn
		} else {
			c.AgentName = "awp-vm-agent"
		}
	}
	if c.WorkDir == "" {
		c.WorkDir = "/var/lib/awp-vm-agent"
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}
	if c.MaxConcurrentTasks <= 0 {
		c.MaxConcurrentTasks = 2
	}
	if c.HeartbeatInterval <= 0 {
		c.HeartbeatInterval = 15 * time.Second
	}
	if c.ShutdownTimeout <= 0 {
		c.ShutdownTimeout = 60 * time.Second
	}
}

func (c *Config) validate() error {
	if c.APIKey == "" {
		return errors.New("config: api_key is required (set AWP_AGENT_API_KEY or api_key in YAML)")
	}
	if c.ServerURL == "" {
		return errors.New("config: server_url is required")
	}
	if err := validateServerURL(c.ServerURL); err != nil {
		return err
	}
	if c.TLSCertPin != "" && len(c.TLSCertPin) != 64 {
		return fmt.Errorf("config: tls_cert_pin must be 64 hex chars (SHA-256), got %d", len(c.TLSCertPin))
	}
	return nil
}

var (
	errServerURLInvalid  = errors.New("config: server_url must be an absolute ws:// or wss:// URL with a valid host")
	errServerURLInsecure = errors.New("config: plain ws:// server_url is allowed only for localhost or a loopback IP")
)

func validateServerURL(raw string) error {
	if raw == "" || strings.TrimSpace(raw) != raw {
		return errServerURLInvalid
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.Host == "" || u.Fragment != "" {
		return errServerURLInvalid
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "ws" && scheme != "wss" {
		return errServerURLInvalid
	}

	host := u.Hostname()
	if host == "" || !validAuthority(u.Host, host) {
		return errServerURLInvalid
	}
	ip := net.ParseIP(host)
	if ip == nil && !validDNSHostname(host) {
		return errServerURLInvalid
	}
	if ip != nil && strings.Contains(host, ":") && ip.To4() != nil {
		return errServerURLInvalid
	}
	if scheme == "ws" {
		loopback := ip != nil && ip.IsLoopback()
		if ip == nil {
			loopback = strings.EqualFold(host, "localhost")
		}
		if !loopback {
			return errServerURLInsecure
		}
	}
	return nil
}

func validAuthority(authority, host string) bool {
	if strings.ContainsAny(authority, "\\\r\n\t") || strings.Contains(authority, "%") {
		return false
	}
	if strings.Contains(host, ":") {
		if !strings.HasPrefix(authority, "[") {
			return false
		}
		closeBracket := strings.IndexByte(authority, ']')
		if closeBracket < 0 || authority[1:closeBracket] != host {
			return false
		}
		return validPortSuffix(authority[closeBracket+1:])
	}
	if strings.ContainsAny(authority, "[]") {
		return false
	}
	if authority == host {
		return true
	}
	prefix := host + ":"
	if !strings.HasPrefix(authority, prefix) {
		return false
	}
	return validPort(authority[len(prefix):])
}

func validPortSuffix(suffix string) bool {
	if suffix == "" {
		return true
	}
	if !strings.HasPrefix(suffix, ":") {
		return false
	}
	return validPort(suffix[1:])
}

func validPort(port string) bool {
	if port == "" {
		return false
	}
	for _, ch := range port {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	n, err := strconv.Atoi(port)
	return err == nil && n >= 1 && n <= 65535
}

func validDNSHostname(host string) bool {
	if host == "" || len(host) > 253 {
		return false
	}
	name := strings.TrimSuffix(host, ".")
	if name == "" || allDigitsAndDots(name) {
		return false
	}
	for _, label := range strings.Split(name, ".") {
		if len(label) == 0 || len(label) > 63 || !isASCIIAlphaNumeric(label[0]) ||
			!isASCIIAlphaNumeric(label[len(label)-1]) {
			return false
		}
		for i := 1; i < len(label)-1; i++ {
			if !isASCIIAlphaNumeric(label[i]) && label[i] != '-' {
				return false
			}
		}
	}
	return true
}

func allDigitsAndDots(s string) bool {
	for _, ch := range s {
		if (ch < '0' || ch > '9') && ch != '.' {
			return false
		}
	}
	return true
}

func isASCIIAlphaNumeric(ch byte) bool {
	return ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9'
}
