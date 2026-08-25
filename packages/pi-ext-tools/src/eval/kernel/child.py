from __future__ import annotations

import ast
import builtins
import io
import json
import os
import sys
import traceback
import threading
import time
from typing import Any
MAX_EVAL_FRAME_CHARS = 1_048_576 + 65_536
_CELL_ID = ""
_TOOL_SEQ = 0
_NS: dict[str, Any] = {"__name__": "__main__", "__builtins__": builtins}
_RAW_STDERR = sys.__stderr__
_CAPTURE_READ_FD: int | None
try:
    _FRAME_FD = os.dup(sys.__stdout__.fileno())
    _FRAME_OUT = os.fdopen(_FRAME_FD, "w", encoding="utf-8", errors="backslashreplace")
    _CAPTURE_READ_FD, _capture_write_fd = os.pipe()
    os.dup2(_capture_write_fd, sys.__stdout__.fileno())
    os.close(_capture_write_fd)
except (AttributeError, OSError, ValueError):
    _FRAME_OUT = sys.__stdout__
    _CAPTURE_READ_FD = None
_SESSION_CWD = os.getcwd()
if _SESSION_CWD not in sys.path:
    sys.path.insert(0, _SESSION_CWD)


def send(message: dict[str, Any]) -> None:
    line = json.dumps(message, default=_json_default, ensure_ascii=False)
    if len(line) > MAX_EVAL_FRAME_CHARS:
        line = json.dumps(
            {
                "type": "done",
                "cellId": message.get("cellId") or _CELL_ID,
                "ok": False,
                "error": "Eval kernel frame exceeded 1 MiB.",
            },
            ensure_ascii=False,
        )
    _FRAME_OUT.write(line)
    _FRAME_OUT.write("\n")
    _FRAME_OUT.flush()


def _drain_captured_stdout() -> None:
    if _CAPTURE_READ_FD is None:
        return
    import codecs

    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    while True:
        try:
            chunk = os.read(_CAPTURE_READ_FD, 65536)
        except OSError:
            return
        if not chunk:
            return
        text = decoder.decode(chunk)
        if text and _CELL_ID:
            send({"type": "text", "cellId": _CELL_ID, "text": text})
        elif text:
            _RAW_STDERR.write(text)
            _RAW_STDERR.flush()


def _start_capture_drain() -> None:
    if _CAPTURE_READ_FD is None:
        return
    threading.Thread(target=_drain_captured_stdout, name="eval-fd1-capture", daemon=True).start()


def _wait_capture_idle() -> None:
    if _CAPTURE_READ_FD is None:
        return
    import select

    deadline = time.monotonic() + 0.2
    while time.monotonic() < deadline:
        ready, _, _ = select.select([_CAPTURE_READ_FD], [], [], 0)
        if not ready:
            return
        time.sleep(0.005)


def _json_default(value: Any) -> str:
    return repr(value)


def clone_value(value: Any) -> Any:
    if value is None:
        return None
    try:
        return json.loads(json.dumps(value, default=_json_default))
    except TypeError:
        return repr(value)


class _StdStream(io.TextIOBase):
    def write(self, data: Any) -> int:  # type: ignore[override]
        text = data if isinstance(data, str) else str(data)
        if text and _CELL_ID:
            send({"type": "text", "cellId": _CELL_ID, "text": text})
        return len(text)

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False


def _reset_session_cwd() -> None:
    os.chdir(_SESSION_CWD)
    try:
        sys.path.remove(_SESSION_CWD)
    except ValueError:
        pass
    sys.path.insert(0, _SESSION_CWD)


def _start_parent_watchdog() -> None:
    if os.name != "posix":
        return
    original_ppid = os.getppid()
    if original_ppid <= 1:
        return

    def watch() -> None:
        while True:
            try:
                if os.getppid() != original_ppid:
                    os._exit(0)
            except Exception:
                return
            time.sleep(10)

    threading.Thread(target=watch, name="eval-parent-watchdog", daemon=True).start()


def _print(*args: Any, **kwargs: Any) -> None:
    file = kwargs.get("file")
    if file not in (None, sys.stdout):
        return builtins.print(*args, **kwargs)
    kwargs.pop("file", None)
    buffer = io.StringIO()
    builtins.print(*args, file=buffer, **kwargs)
    text = buffer.getvalue()
    if text and _CELL_ID:
        send({"type": "text", "cellId": _CELL_ID, "text": text})


def _display(value: Any) -> None:
    if not _CELL_ID:
        return
    send({"type": "display", "cellId": _CELL_ID, "value": clone_value(value)})


def _cwd() -> str:
    return os.getcwd()


class EvalToolError(Exception):
    def __init__(self, message: str, trace: Any = None) -> None:
        super().__init__(message)
        self.name = "EvalToolError"
        self.trace = trace


def _read_message() -> dict[str, Any]:
    line = sys.stdin.readline(MAX_EVAL_FRAME_CHARS + 1)
    if line == "":
        raise EOFError("Eval host closed the kernel.")
    if len(line) > MAX_EVAL_FRAME_CHARS:
        raise SystemExit("Eval kernel frame exceeded 1 MiB.")
    return json.loads(line)


def _call_tool(name: str, args: Any) -> Any:
    global _TOOL_SEQ
    _TOOL_SEQ += 1
    request_id = f"{_CELL_ID}:{_TOOL_SEQ}"
    send(
        {
            "type": "toolCall",
            "cellId": _CELL_ID,
            "id": request_id,
            "name": name,
            "args": clone_value(args),
        }
    )
    while True:
        message = _read_message()
        if message.get("type") == "shutdown":
            raise SystemExit(0)
        if message.get("type") != "toolResult" or message.get("id") != request_id:
            continue
        if message.get("ok"):
            return message.get("value")
        error = message.get("error") or {}
        raise EvalToolError(
            str(error.get("message") or f"{name} failed"),
            error.get("trace"),
        )


class _ToolMethod:
    def __init__(self, name: str) -> None:
        self._name = name

    def __call__(self, args: Any = None, **kwargs: Any) -> Any:
        if args is not None and kwargs:
            raise TypeError("tool methods accept a dict or keyword arguments, not both")
        if args is None:
            payload: Any = kwargs
        elif isinstance(args, dict):
            payload = args
        else:
            raise TypeError("tool methods expect a dict of arguments")
        return _call_tool(self._name, payload)


class _ToolProxy:
    def __getattr__(self, name: str) -> _ToolMethod:
        return _ToolMethod(name)


def _compile_source(code: str) -> tuple[Any, bool]:
    tree = ast.parse(code, filename="<eval>")
    if not tree.body:
        return compile(tree, "<eval>", "exec"), False
    last = tree.body[-1]
    if not isinstance(last, ast.Expr):
        return compile(tree, "<eval>", "exec"), False
    tree.body[-1] = ast.Assign(
        targets=[ast.Name(id="__eval_final__", ctx=ast.Store())],
        value=last.value,
    )
    ast.fix_missing_locations(tree)
    return compile(tree, "<eval>", "exec"), True


def _execute(cell_id: str, code: str) -> None:
    global _CELL_ID
    _reset_session_cwd()
    _CELL_ID = cell_id
    _NS["print"] = _print
    _NS["display"] = _display
    _NS["cwd"] = _cwd
    _NS["tool"] = _ToolProxy()
    _NS["EvalToolError"] = EvalToolError
    _NS.pop("__eval_final__", None)
    try:
        compiled, has_value = _compile_source(code)
        exec(compiled, _NS, _NS)
        value = _NS.pop("__eval_final__", None) if has_value else None
        _wait_capture_idle()
        send({"type": "done", "cellId": cell_id, "ok": True, "value": clone_value(value)})
    except KeyboardInterrupt:
        _wait_capture_idle()
        send({"type": "done", "cellId": cell_id, "ok": False, "error": "Eval was aborted."})
    except Exception as error:
        _wait_capture_idle()
        message = traceback.format_exc() or str(error) or type(error).__name__
        send({"type": "done", "cellId": cell_id, "ok": False, "error": message[:4000]})
    finally:
        _CELL_ID = ""


sys.stdout = _StdStream()
sys.stderr = _StdStream()
_start_parent_watchdog()
_start_capture_drain()
send({"type": "ready"})

while True:
    try:
        incoming = _read_message()
    except EOFError:
        break
    except KeyboardInterrupt:
        continue
    kind = incoming.get("type")
    if kind == "shutdown":
        break
    if kind == "execute":
        _execute(str(incoming.get("cellId") or ""), str(incoming.get("code") or ""))
