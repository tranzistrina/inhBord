from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from flask import Flask, abort, jsonify, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("INHBORD_DATA_DIR", BASE_DIR / "data" / "boards"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Total serialized board files may not exceed 1 GiB.
MAX_STORAGE_BYTES = int(os.environ.get("INHBORD_MAX_STORAGE_BYTES", 1024**3))
MAX_TEXT_CHARS = int(os.environ.get("INHBORD_MAX_TEXT_CHARS", 2_000_000))
IDLE_SAVE_SECONDS = 10 * 60
EMPTY_SAVE_SECONDS = 3
HOUSEKEEPING_SECONDS = 15

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("INHBORD_SECRET_KEY", "change-this-secret-before-deploying")
socketio = SocketIO(app, cors_allowed_origins=os.environ.get("INHBORD_CORS", "*"), async_mode="threading")

lock = threading.RLock()
boards: dict[str, dict[str, Any]] = {}
sid_board: dict[str, str] = {}
sid_names: dict[str, str] = {}


def valid_board_id(board_id: str) -> bool:
    return bool(re.fullmatch(r"[a-f0-9]{12}", board_id or ""))


def board_path(board_id: str) -> Path:
    if not valid_board_id(board_id):
        raise ValueError("Invalid board ID")
    return DATA_DIR / f"{board_id}.json"


def storage_used(exclude: str | None = None) -> int:
    total = 0
    for p in DATA_DIR.glob("*.json"):
        if exclude and p.name == f"{exclude}.json":
            continue
        try:
            total += p.stat().st_size
        except FileNotFoundError:
            pass
    return total


def read_board(board_id: str) -> dict[str, Any] | None:
    path = board_path(board_id)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("text", ""), str):
            return None
        return {
            "id": board_id,
            "name": str(payload.get("name") or "Без названия")[:80],
            "text": payload.get("text", "")[:MAX_TEXT_CHARS],
            "updated_at": float(payload.get("updated_at", time.time())),
        }
    except (OSError, ValueError, json.JSONDecodeError):
        app.logger.exception("Cannot read board %s", board_id)
        return None


def public_board(board: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": board["id"],
        "name": board["name"],
        "text": board["text"],
        "updated_at": board["updated_at"],
        "online": len(board["members"]),
        "dirty": board["dirty"],
    }


def persisted_listing() -> list[dict[str, Any]]:
    result = []
    for p in DATA_DIR.glob("*.json"):
        board_id = p.stem
        data = read_board(board_id) if valid_board_id(board_id) else None
        if data:
            result.append({
                "id": board_id,
                "name": data["name"],
                "updated_at": data["updated_at"],
                "size": p.stat().st_size,
            })
    return sorted(result, key=lambda item: item["updated_at"], reverse=True)


def save_board(board_id: str, *, force: bool = False) -> bool:
    """Atomically persist a board; refuses writes that breach the total disk quota."""
    with lock:
        board = boards.get(board_id)
        if not board:
            return False
        if not force and not board["dirty"]:
            return True
        payload = {
            "id": board_id,
            "name": board["name"],
            "text": board["text"],
            "updated_at": board["updated_at"],
        }
        encoded = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        path = board_path(board_id)
        if storage_used(exclude=board_id) + len(encoded) > MAX_STORAGE_BYTES:
            socketio.emit("storage_limit", {"message": "Лимит хранилища досок (1 ГБ) исчерпан. Изменения пока остаются в памяти сервера."}, to=board_id)
            return False
        tmp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        try:
            with tmp.open("wb") as f:
                f.write(encoded)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
            board["dirty"] = False
            board["last_saved"] = time.time()
            return True
        except OSError:
            app.logger.exception("Cannot save board %s", board_id)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            return False


def load_into_memory(board_id: str) -> dict[str, Any] | None:
    stored = read_board(board_id)
    if not stored:
        return None
    return {
        **stored,
        "members": set(),
        "last_activity": time.time(),
        "last_saved": time.time(),
        "dirty": False,
    }


def list_boards() -> list[dict[str, Any]]:
    with lock:
        live = {
            bid: {"id": bid, "name": b["name"], "updated_at": b["updated_at"],
                  "online": len(b["members"]), "dirty": b["dirty"]}
            for bid, b in boards.items()
        }
    for item in persisted_listing():
        live.setdefault(item["id"], {**item, "online": 0, "dirty": False})
    return sorted(live.values(), key=lambda item: item.get("updated_at", 0), reverse=True)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/boards")
def api_boards():
    return jsonify({"boards": list_boards(), "storage": storage_used(), "storage_limit": MAX_STORAGE_BYTES})


@app.post("/api/boards")
def api_create_board():
    body = request.get_json(silent=True) or {}
    name = str(body.get("name") or "Новая доска").strip()[:80] or "Новая доска"
    board_id = uuid.uuid4().hex[:12]
    now = time.time()
    with lock:
        boards[board_id] = {
            "id": board_id, "name": name, "text": "", "updated_at": now,
            "members": set(), "last_activity": now, "last_saved": now, "dirty": True,
        }
    if not save_board(board_id, force=True):
        with lock:
            boards.pop(board_id, None)
        return jsonify({"error": "Не удалось сохранить доску: лимит хранилища исчерпан или диск недоступен."}), 507
    return jsonify({"board": {"id": board_id, "name": name, "updated_at": now}}), 201


@app.get("/api/boards/<board_id>")
def api_get_board(board_id: str):
    if not valid_board_id(board_id):
        abort(404)
    with lock:
        board = boards.get(board_id)
        if board:
            return jsonify({"board": public_board(board)})
    stored = read_board(board_id)
    if not stored:
        abort(404)
    return jsonify({"board": {**stored, "online": 0, "dirty": False}})


@app.delete("/api/boards/<board_id>")
def api_delete_board(board_id: str):
    if not valid_board_id(board_id):
        abort(404)
    with lock:
        board = boards.get(board_id)
        if board and board["members"]:
            return jsonify({"error": "Нельзя удалить доску, пока в ней находятся пользователи."}), 409
        boards.pop(board_id, None)
    try:
        board_path(board_id).unlink(missing_ok=True)
    except OSError:
        app.logger.exception("Cannot delete board %s", board_id)
        return jsonify({"error": "Не удалось удалить файл доски."}), 500
    return jsonify({"ok": True})


@socketio.on("join_board")
def on_join(data):
    data = data if isinstance(data, dict) else {}
    board_id = str(data.get("board_id", ""))
    if not valid_board_id(board_id):
        emit("board_error", {"message": "Некорректный адрес доски."})
        return
    name = str(data.get("name") or "Гость").strip()[:24] or "Гость"
    previous = sid_board.get(request.sid)
    if previous and previous != board_id:
        leave_room(previous)
        with lock:
            old = boards.get(previous)
            old_online = 0
            if old:
                old["members"].discard(request.sid)
                old["last_activity"] = time.time()
                old_online = len(old["members"])
                should_save_old = old_online == 0
            else:
                should_save_old = False
        socketio.emit("presence", {"online": old_online}, to=previous)
        if should_save_old:
            save_board(previous, force=True)
    with lock:
        board = boards.get(board_id)
        if board is None:
            board = load_into_memory(board_id)
            if board is not None:
                boards[board_id] = board
        if board is None:
            emit("board_error", {"message": "Доска не найдена."})
            return
        sid_board[request.sid] = board_id
        sid_names[request.sid] = name
        board["members"].add(request.sid)
        board["last_activity"] = time.time()
        state = public_board(board)
        online = len(board["members"])
    join_room(board_id)
    emit("board_state", state)
    socketio.emit("presence", {"online": online}, to=board_id)


@socketio.on("text_change")
def on_text_change(data):
    data = data if isinstance(data, dict) else {}
    board_id = sid_board.get(request.sid)
    if not board_id:
        emit("board_error", {"message": "Сначала откройте доску."})
        return
    text_value = data.get("text", "")
    if not isinstance(text_value, str):
        emit("board_error", {"message": "Некорректный текст."})
        return
    if len(text_value) > MAX_TEXT_CHARS:
        emit("board_error", {"message": f"Текст слишком большой. Лимит: {MAX_TEXT_CHARS:,} символов."})
        return
    with lock:
        board = boards.get(board_id)
        if not board:
            emit("board_error", {"message": "Доска больше не активна."})
            return
        board["text"] = text_value
        board["updated_at"] = time.time()
        board["last_activity"] = time.time()
        board["dirty"] = True
        online = len(board["members"])
    # Broadcast one authoritative whole-text snapshot to every visitor on this board.
    socketio.emit("text_update", {"text": text_value, "updated_at": board["updated_at"]}, to=board_id, include_self=False)
    emit("change_ack", {"updated_at": board["updated_at"]})
    socketio.emit("board_meta", {"online": online, "updated_at": board["updated_at"]}, to=board_id)


@socketio.on("rename_board")
def on_rename(data):
    board_id = sid_board.get(request.sid)
    name = str((data or {}).get("name") or "").strip()[:80]
    if not board_id or not name:
        return
    with lock:
        board = boards.get(board_id)
        if not board:
            return
        board["name"] = name
        board["updated_at"] = time.time()
        board["last_activity"] = time.time()
        board["dirty"] = True
    socketio.emit("board_renamed", {"name": name, "updated_at": board["updated_at"]}, to=board_id)
    save_board(board_id, force=True)


@socketio.on("disconnect")
def on_disconnect():
    board_id = sid_board.pop(request.sid, None)
    sid_names.pop(request.sid, None)
    if not board_id:
        return
    with lock:
        board = boards.get(board_id)
        if not board:
            return
        board["members"].discard(request.sid)
        board["last_activity"] = time.time()
        online = len(board["members"])
    socketio.emit("presence", {"online": online}, to=board_id)
    if online == 0:
        # Flush immediately when the final visitor leaves.
        save_board(board_id, force=True)


def housekeeping():
    while True:
        socketio.sleep(HOUSEKEEPING_SECONDS)
        now = time.time()
        with lock:
            candidates = [
                bid for bid, b in boards.items()
                if (not b["members"] and (now - b["last_activity"] >= EMPTY_SAVE_SECONDS))
                or (now - b["last_activity"] >= IDLE_SAVE_SECONDS)
            ]
        for board_id in candidates:
            with lock:
                board = boards.get(board_id)
                if not board:
                    continue
                # Idle boards with connected users are persisted but remain live.
                remove_from_memory = not board["members"]
            save_board(board_id, force=True)
            if remove_from_memory:
                with lock:
                    current = boards.get(board_id)
                    if current and not current["members"] and time.time() - current["last_activity"] >= EMPTY_SAVE_SECONDS:
                        boards.pop(board_id, None)


@socketio.on("connect")
def on_connect():
    # start_background_task is guarded so development reloader won't start duplicate loops.
    global _cleanup_started
    try:
        started = _cleanup_started
    except NameError:
        started = False
    if not started:
        _cleanup_started = True
        socketio.start_background_task(housekeeping)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    socketio.run(app, host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
