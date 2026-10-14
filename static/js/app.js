(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const homeView = $("homeView");
  const boardView = $("boardView");
  const boardsGrid = $("boardsGrid");
  const modalLayer = $("modalLayer");
  const modalForm = $("modalForm");
  const modalInput = $("modalInput");
  const editor = $("sharedText");
  const LIMIT = 2_000_000;

  let socket = null;
  let activeBoard = null;
  let suppressInput = false;
  let saveTimer = null;
  let toastTimer = null;
  let modalAction = null;
  let lastLocalText = "";
  let lastEditAt = 0;
  let pendingRemote = null;
  let connected = false;

  const fmtBytes = (bytes) => {
    if (!bytes) return "0 Б";
    const units = ["Б", "КБ", "МБ", "ГБ"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / (1024 ** i)).toLocaleString("ru-RU", { maximumFractionDigits: i ? 1 : 0 }) + " " + units[i];
  };
  const relativeTime = (timestamp) => {
    if (!timestamp) return "Нет изменений";
    const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
    if (seconds < 60) return "только что";
    if (seconds < 3600) return Math.floor(seconds / 60) + " мин. назад";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " ч. назад";
    return new Date(timestamp * 1000).toLocaleDateString("ru-RU");
  };
  const wordStats = (text) => {
    const trimmed = text.trim();
    const words = trimmed ? trimmed.split(/\s+/u).length : 0;
    $("wordStats").textContent = words.toLocaleString("ru-RU") + " слов · " + text.length.toLocaleString("ru-RU") + " символов";
  };
  const notify = (message, isError = false) => {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
  };
  const setSaveState = (saving, detail) => {
    $("saveIndicator").classList.toggle("saving", saving);
    $("saveIndicator").textContent = saving ? "↻" : "✓";
    $("saveLabel").textContent = saving ? "Синхронизация…" : "Изменения общие";
    $("saveTime").textContent = detail || (saving ? "Отправляем обновление" : "Изменения видны всем");
  };
  const setConnected = (value) => {
    connected = value;
    $("connectionLabel").textContent = value ? "Подключено · онлайн" : "Нет соединения";
    $("connectionLabel").style.color = value ? "#9fe5c5" : "#f0a0a9";
    if (value) setSaveState(false, "Изменения видны всем");
  };

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || "Ошибка запроса (" + response.status + ")");
    return payload;
  }

  function renderBoards(boards) {
    $("boardCount").textContent = boards.length + " " + plural(boards.length, ["доска", "доски", "досок"]);
    if (!boards.length) {
      boardsGrid.innerHTML = '<div class="loading-board">Пока нет ни одной доски. Создайте первую и начните писать вместе.</div>';
    } else {
      boardsGrid.innerHTML = boards.map((board) => {
        const id = String(board.id);
        const name = escapeHtml(board.name || "Без названия");
        const online = Number(board.online || 0);
        const dirty = board.dirty ? '<span class="dirty-mini">● изменено</span>' : "";
        const active = online ? '<span class="online-mini"><i></i>' + online + " онлайн</span>" : '<span>Общее пространство</span>';
        return '<button class="board-card" data-board="' + id + '" type="button">' +
          '<div class="board-card-top"><span class="board-symbol">≡</span><span class="board-time">' + escapeHtml(relativeTime(board.updated_at)) + '</span></div>' +
          '<h3>' + name + '</h3><div class="board-card-bottom">' + active + dirty + '</div></button>';
      }).join("");
    }
    boardsGrid.insertAdjacentHTML("beforeend", '<button id="addBoardCard" class="create-card" type="button"><span class="create-plus">＋</span><b>Создать новую доску</b><small>Новая страница для идей</small></button>');
    boardsGrid.querySelectorAll("[data-board]").forEach((button) => {
      button.addEventListener("click", () => openBoard(button.dataset.board));
    });
    $("addBoardCard").addEventListener("click", showCreateModal);
  }

  function plural(n, forms) {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return forms[1];
    return forms[2];
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  }

  async function refreshBoards() {
    try {
      const data = await api("/api/boards");
      renderBoards(data.boards || []);
      const used = Number(data.storage || 0);
      const max = Number(data.storage_limit || 1024 ** 3);
      const percent = max ? Math.min(100, used / max * 100) : 0;
      $("storageText").textContent = fmtBytes(used) + " из " + fmtBytes(max);
      $("storageFill").style.width = percent + "%";
      $("storagePercent").textContent = Math.round(percent) + "%";
    } catch (error) {
      boardsGrid.innerHTML = '<div class="loading-board">Не удалось загрузить доски: ' + escapeHtml(error.message) + '</div>';
    }
  }

  function showModal({title, description, placeholder, confirm, initial = "", action}) {
    $("modalTitle").textContent = title;
    $("modalDescription").textContent = description;
    modalInput.placeholder = placeholder;
    modalInput.value = initial;
    $("modalConfirm").innerHTML = confirm;
    modalAction = action;
    modalLayer.classList.remove("hidden");
    setTimeout(() => { modalInput.focus(); modalInput.select(); }, 30);
  }
  function hideModal() {
    modalLayer.classList.add("hidden");
    modalAction = null;
  }
  function showCreateModal() {
    showModal({
      title: "Создать доску",
      description: "Дайте общему пространству короткое и понятное название.",
      placeholder: "Например, идеи для проекта",
      confirm: 'Создать доску <span class="btn-arrow">↗</span>',
      action: async (name) => {
        const data = await api("/api/boards", {method: "POST", body: JSON.stringify({name: name || "Новая доска"})});
        hideModal();
        await refreshBoards();
        history.pushState({board: data.board.id}, "", "/?board=" + data.board.id);
        openBoard(data.board.id, data.board);
      }
    });
  }

  function connectSocket() {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    socket = io({transports: ["websocket", "polling"]});
    socket.on("connect", () => {
      setConnected(true);
      if (activeBoard) socket.emit("join_board", {board_id: activeBoard.id, name: "Участник"});
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));
    socket.on("board_state", (board) => {
      if (!activeBoard || board.id !== activeBoard.id) return;
      activeBoard.name = board.name;
      suppressInput = true;
      editor.value = board.text || "";
      lastLocalText = editor.value;
      suppressInput = false;
      updateBoardLabels(board);
      wordStats(editor.value);
      $("onlineCount").textContent = board.online || 1;
      setSaveState(false, "Изменения видны всем");
      $("lastChanged").textContent = "Последнее изменение: " + relativeTime(board.updated_at);
    });
    socket.on("text_update", (payload) => {
      if (!activeBoard || !payload || typeof payload.text !== "string") return;
      // Preserve the focused writer's caret when another participant types elsewhere.
      const selectionStart = editor.selectionStart;
      const selectionEnd = editor.selectionEnd;
      const wasFocused = document.activeElement === editor;
      if (wasFocused && Date.now() - lastEditAt < 1200 && localText !== payload.text) {
        pendingRemote = payload;
        return;
      }
      applyRemoteText(payload.text, selectionStart, selectionEnd, wasFocused);
      $("lastChanged").textContent = "Обновлено " + new Date((payload.updated_at || Date.now()/1000) * 1000).toLocaleTimeString("ru-RU", {hour:"2-digit",minute:"2-digit"});
    });
    socket.on("change_ack", (payload) => {
      setSaveState(false, "Изменения синхронизированы");
      if (payload && payload.updated_at) $("lastChanged").textContent = "Обновлено " + new Date(payload.updated_at * 1000).toLocaleTimeString("ru-RU", {hour:"2-digit",minute:"2-digit"});
    });
    socket.on("presence", (payload) => {
      if (payload && typeof payload.online === "number") $("onlineCount").textContent = payload.online;
    });
    socket.on("board_meta", (payload) => {
      if (payload && typeof payload.online === "number") $("onlineCount").textContent = payload.online;
    });
    socket.on("board_renamed", (payload) => {
      if (!activeBoard || !payload) return;
      activeBoard.name = payload.name;
      updateBoardLabels(payload);
    });
    socket.on("board_error", (payload) => notify(payload?.message || "Ошибка доски", true));
    socket.on("storage_limit", (payload) => notify(payload?.message || "Недостаточно места на диске", true));
  }

  function applyRemoteText(text, start, end, wasFocused) {
    suppressInput = true;
    editor.value = text;
    lastLocalText = text;
    suppressInput = false;
    if (wasFocused) {
      const caret = Math.min(text.length, start);
      try { editor.setSelectionRange(caret, Math.min(text.length, end)); } catch (_) {}
    }
    wordStats(text);
    setSaveState(false, "Получены общие изменения");
  }
  function updateBoardLabels(board) {
    const name = board.name || "Без названия";
    $("boardTitle").innerHTML = escapeHtml(name) + '<span class="title-period">.</span>';
    $("breadcrumbName").textContent = name;
    $("editorDocName").textContent = name + ".txt";
    document.title = name + " — inhBord";
  }

  async function openBoard(id, knownData = null) {
    if (!/^[a-f0-9]{12}$/.test(String(id))) return;
    clearTimeout(saveTimer);
    activeBoard = {id, name: knownData?.name || "Доска"};
    homeView.classList.add("hidden");
    boardView.classList.remove("hidden");
    editor.value = "";
    wordStats("");
    updateBoardLabels(activeBoard);
    $("onlineCount").textContent = "…";
    $("lastChanged").textContent = "Подключаемся к доске…";
    history.replaceState({board: id}, "", "/?board=" + id);
    if (!socket) connectSocket();
    try {
      const data = await api("/api/boards/" + id);
      if (!activeBoard || activeBoard.id !== id) return;
      activeBoard.name = data.board.name;
      // Join delivers the authoritative live state; API content serves as immediate fallback.
      suppressInput = true;
      editor.value = data.board.text || "";
      lastLocalText = editor.value;
      suppressInput = false;
      wordStats(editor.value);
      updateBoardLabels(data.board);
      if (socket.connected) socket.emit("join_board", {board_id: id, name: "Участник"});
    } catch (error) {
      notify(error.message, true);
      backToHome(false);
    }
  }

  function backToHome(push = true) {
    activeBoard = null;
    clearTimeout(saveTimer);
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    boardView.classList.add("hidden");
    homeView.classList.remove("hidden");
    document.title = "inhBord — пространство общих мыслей";
    if (push) history.pushState({}, "", "/");
    refreshBoards();
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(editor.value);
      notify("Весь текст скопирован в буфер обмена.");
    } catch (_) {
      editor.focus(); editor.select();
      const success = document.execCommand("copy");
      notify(success ? "Весь текст скопирован." : "Браузер запретил доступ к буферу обмена.", !success);
    }
  }
  async function pasteAll() {
    try {
      const text = await navigator.clipboard.readText();
      if (text.length > LIMIT) { notify("Вставляемый текст превышает лимит в 2 млн символов.", true); return; }
      editor.value = text;
      editor.dispatchEvent(new Event("input", {bubbles: true}));
      notify("Текст вставлен и отправлен всем участникам.");
      editor.focus();
    } catch (_) {
      notify("Браузер не разрешил чтение буфера. Разрешите вставку или используйте Ctrl+V в поле текста.", true);
      editor.focus();
    }
  }
  function downloadAll() {
    const blob = new Blob([editor.value], {type: "text/plain;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safe = (activeBoard?.name || "inhBord").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
    link.href = url; link.download = safe + ".txt";
    document.body.appendChild(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
    notify("Текст скачан в TXT-файл.");
  }

  editor.addEventListener("input", () => {
    if (suppressInput || !activeBoard) return;
    if (editor.value.length > LIMIT) {
      const start = editor.selectionStart, end = editor.selectionEnd;
      editor.value = editor.value.slice(0, LIMIT);
      try { editor.setSelectionRange(Math.min(start, LIMIT), Math.min(end, LIMIT)); } catch (_) {}
      notify("Достигнут лимит текста: 2 млн символов.", true);
    }
    lastEditAt = Date.now();
    lastLocalText = editor.value;
    wordStats(editor.value);
    setSaveState(true, "Отправляем обновление участникам");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!socket || !socket.connected) {
        setSaveState(true, "Нет соединения, ждём восстановления");
        return;
      }
      socket.emit("text_change", {text: editor.value});
    }, 120);
  });
  // If rapid local typing briefly delayed a remote snapshot, reconcile after the user pauses.
  setInterval(() => {
    if (!pendingRemote || !activeBoard || document.activeElement === editor && Date.now() - lastEditAt < 1300) return;
    const payload = pendingRemote;
    pendingRemote = null;
    if (editor.value !== payload.text) applyRemoteText(payload.text, editor.selectionStart, editor.selectionEnd, document.activeElement === editor);
  }, 350);

  $("createBoard").addEventListener("click", showCreateModal);
  $("openRecent").addEventListener("click", async () => {
    try {
      const data = await api("/api/boards");
      if (data.boards?.length) openBoard(data.boards[0].id);
      else showCreateModal();
    } catch (error) { notify(error.message, true); }
  });
  $("backHome").addEventListener("click", () => backToHome());
  $("copyAll").addEventListener("click", copyAll);
  $("pasteAll").addEventListener("click", pasteAll);
  $("downloadAll").addEventListener("click", downloadAll);
  $("modalClose").addEventListener("click", hideModal);
  $("modalCancel").addEventListener("click", hideModal);
  modalLayer.addEventListener("click", (event) => { if (event.target === modalLayer) hideModal(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modalLayer.classList.contains("hidden")) hideModal();
  });
  modalForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!modalAction) return;
    const submit = $("modalConfirm");
    const action = modalAction;
    submit.disabled = true;
    try { await action(modalInput.value.trim()); }
    catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; }
  });
  $("renameBoard").addEventListener("click", () => {
    if (!activeBoard) return;
    showModal({
      title: "Переименовать доску",
      description: "Новое название увидят все участники доски.",
      placeholder: "Название доски",
      initial: activeBoard.name,
      confirm: "Сохранить название <span class=\"btn-arrow\">↗</span>",
      action: async (name) => {
        if (!name) { notify("Название не может быть пустым.", true); return; }
        if (!socket || !socket.connected) throw new Error("Нет соединения с сервером.");
        socket.emit("rename_board", {name});
        hideModal();
        notify("Название доски обновлено.");
      }
    });
  });
  $("deleteBoard").addEventListener("click", async () => {
    if (!activeBoard) return;
    if (!confirm("Удалить доску «" + activeBoard.name + "» вместе с сохранённым текстом? Это действие нельзя отменить.")) return;
    const id = activeBoard.id;
    try {
      if (socket) socket.disconnect();
      await api("/api/boards/" + id, {method: "DELETE"});
      notify("Доска удалена.");
      backToHome();
    } catch (error) {
      if (socket && !socket.connected) socket.connect();
      notify(error.message, true);
    }
  });
  window.addEventListener("popstate", () => {
    const id = new URLSearchParams(location.search).get("board");
    if (id) openBoard(id);
    else backToHome(false);
  });
  // Pull current state periodically for the home dashboard, not for collaborative text.
  refreshBoards();
  setInterval(() => { if (!activeBoard) refreshBoards(); }, 15000);
  connectSocket();
  const initialBoard = new URLSearchParams(location.search).get("board");
  if (initialBoard) openBoard(initialBoard);
})();
