#!/usr/bin/env python3
"""A mock of the Responses API for the spare10 end-to-end runs and live checks (Codex design 8.3, 9.1).

No real model and no quota: Codex sends every model request here.

Usage: python3 codex/e2e/mock_responses.py <work dir>

- It listens on 127.0.0.1 on a free port, and writes the port to <work>/port.
- Each POST .../responses is one model request. It gets one line in <work>/requests.jsonl, so
  `wc -l < <work>/requests.jsonl` is the number of model requests. Every other request gets a 404 and a line
  in <work>/other.jsonl.
- The first word of the last user text picks the reply:
    TOOL       one exec_command (echo e2e), then the final message "done"
    TOOL2 [s]  two exec_command rounds (the first after s seconds), then "done"
    SLOW [s]   the final message "ok" after 20 s (or after s seconds)
    SLOWTOOL [s]  as TOOL, but the first reply comes after 3 s (or after s seconds)
    LONG       one exec_command that sleeps 15 s, then write_stdin checks until it ends, then "done"
    LONGSPAWN  as LONG, and in the same reply one spawn_agent whose child message is TOOL2 7
    SPAWN [s] [child words]  one multi_agent_v1 spawn_agent whose child message is CHILDTOOL (or the child
               words), then "done" (after s seconds)
    CHILDTOOL  as TOOL, in the child thread
    any other  the final message "ok"
- The rate limit headers of each response come from <work>/limits.json, a map of header names to values, such
  as {"x-codex-primary-used-percent": 50, "x-codex-primary-window-minutes": 10080, "x-codex-primary-reset-at": 1790000000}.
  The file is read for each response, so a run can change it between requests. When <work>/limits-<WORD>.json
  exists, a request whose first word is WORD takes the headers from it instead (for example CHILDTOOL).
- <work>/usage.json, when it exists, sets the usage of each response: {"input_tokens": 200000, "output_tokens": 1}.
"""
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WORK = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
REQUESTS = os.path.join(WORK, "requests.jsonl")
OTHER = os.path.join(WORK, "other.jsonl")
lock = threading.Lock()
state = {"n": 0}


def read_json(name, default):
    try:
        with open(os.path.join(WORK, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def append(path, obj):
    with lock, open(path, "a") as f:
        f.write(json.dumps(obj) + "\n")


def sse(events):
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def created(rid):
    return {"type": "response.created", "response": {"id": rid}}


def completed(rid):
    u = read_json("usage.json", {})
    i = int(u.get("input_tokens", 1))
    o = int(u.get("output_tokens", 1))
    return {"type": "response.completed", "response": {"id": rid, "usage": {
        "input_tokens": i, "input_tokens_details": None, "output_tokens": o,
        "output_tokens_details": None, "total_tokens": i + o}}}


def message(rid, text):
    return {"type": "response.output_item.done", "item": {
        "type": "message", "role": "assistant", "id": rid + "-m",
        "content": [{"type": "output_text", "text": text}]}}


def fcall(call_id, name, args, namespace=None):
    item = {"type": "function_call", "call_id": call_id, "name": name, "arguments": json.dumps(args)}
    if namespace:
        item["namespace"] = namespace
    return {"type": "response.output_item.done", "item": item}


def user_text(item):
    if item.get("type") != "message" or item.get("role") != "user":
        return None
    parts = [c.get("text", "") for c in item.get("content") or [] if isinstance(c, dict) and c.get("type") == "input_text"]
    return "\n".join(parts) if parts else None


def last_prompt(items):
    """The last user text that is a prompt, and its index. Codex wraps its own context in tags, such as
    <environment_context>, and a prompt does not start with "<"."""
    at, text = -1, ""
    for i, it in enumerate(items):
        t = user_text(it) if isinstance(it, dict) else None
        if t is not None and not t.lstrip().startswith("<"):
            at, text = i, t
    return at, text


def seconds(words, default):
    try:
        return float(words[1]) if len(words) > 1 else default
    except ValueError:
        return default


def reply_for(items, k):
    """(kind, events, delay in seconds) of request k: the first word of the last prompt, and the tool outputs after it."""
    rid = f"resp-{k}"
    at, prompt = last_prompt(items)
    outputs = [it for it in items[at + 1:] if isinstance(it, dict)
               and it.get("type") in ("function_call_output", "custom_tool_call_output")]
    words = prompt.split()
    word = words[0] if words else ""
    n_out = len(outputs)

    def done():
        return "done", [created(rid), message(rid, "done"), completed(rid)], 0

    def tool(kind, cmd, delay=0, **extra):
        return kind, [created(rid), fcall(f"call-{k}", "exec_command", {"cmd": cmd, **extra}), completed(rid)], delay

    if word in ("TOOL", "CHILDTOOL"):
        return tool("tool", "echo e2e") if n_out == 0 else done()
    if word == "SLOWTOOL":
        return tool("slowtool", "echo e2e", seconds(words, 3.0)) if n_out == 0 else done()
    if word == "TOOL2":
        if n_out >= 2:
            return done()
        return tool(f"tool{n_out + 1}", f"echo e2e-{n_out + 1}", seconds(words, 0.0) if n_out == 0 else 0)
    if word == "SLOW":
        return "slow", [created(rid), message(rid, "ok"), completed(rid)], seconds(words, 20.0)
    if word in ("LONG", "LONGSPAWN"):
        if n_out == 0:
            long_call = fcall(f"call-{k}", "exec_command", {"cmd": "sleep 15; echo long-done", "yield_time_ms": 1000})
            if word == "LONG":
                return "long", [created(rid), long_call, completed(rid)], 0
            spawn = fcall(f"call-{k}s", "spawn_agent", {"message": "TOOL2 7", "agent_type": "worker"}, "multi_agent_v1")
            return "longspawn", [created(rid), long_call, spawn, completed(rid)], 0
        # The newest output of the shell command: a running session to poll, or its end.
        for it in reversed(outputs):
            out = it.get("output")
            text = out if isinstance(out, str) else json.dumps(out)
            if "long-done" in text:
                return done()
            m = re.search(r"session ID (\d+)", text)
            if m:
                args = {"session_id": int(m.group(1)), "chars": "", "yield_time_ms": 5000}
                return "poll", [created(rid), fcall(f"call-{k}", "write_stdin", args), completed(rid)], 0
        return done()
    if word == "SPAWN":
        rest = words[1:]
        wait = 0.0
        if rest and re.fullmatch(r"\d+(\.\d+)?", rest[0]):
            wait = float(rest[0])
            rest = rest[1:]
        if n_out == 0:
            args = {"message": " ".join(rest) or "CHILDTOOL run one command", "agent_type": "worker"}
            return "spawn", [created(rid), fcall(f"call-{k}", "spawn_agent", args, "multi_agent_v1"), completed(rid)], 0
        kind, events, _ = done()
        return kind, events, wait
    return "ok", [created(rid), message(rid, "ok"), completed(rid)], 0


def limits_for(items):
    """The rate limit headers of a request: limits-<WORD>.json for its first word when it exists, else limits.json."""
    _, prompt = last_prompt(items)
    words = prompt.split()
    if words and re.fullmatch(r"[A-Z0-9]+", words[0]) and os.path.exists(os.path.join(WORK, f"limits-{words[0]}.json")):
        return read_json(f"limits-{words[0]}.json", {})
    return read_json("limits.json", {})


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def other(self, body=None):
        append(OTHER, {"t": round(time.time(), 3), "method": self.command, "path": self.path, "body": body})
        self.send_response(404)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_GET(self):
        self.other()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", "0") or 0))
        try:
            req = json.loads(raw)
        except ValueError:
            req = None
        if not self.path.rstrip("/").endswith("/responses") or not isinstance(req, dict):
            self.other(raw.decode(errors="replace")[:2000])
            return
        with lock:
            state["n"] += 1
            k = state["n"]
        items = req.get("input") or []
        at = time.time()
        kind, events, delay = reply_for(items, k)
        append(REQUESTS, {"n": k, "t": round(at, 3), "path": self.path, "model": req.get("model"), "kind": kind,
                          "input": items})
        if delay > 0:
            time.sleep(delay)
        data = sse(events)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        for name, value in limits_for(items).items():
            self.send_header(name, str(value))
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    os.makedirs(WORK, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    tmp = os.path.join(WORK, f"port.{os.getpid()}")
    with open(tmp, "w") as f:
        f.write(str(server.server_address[1]))
    os.replace(tmp, os.path.join(WORK, "port"))
    server.serve_forever()


if __name__ == "__main__":
    main()
