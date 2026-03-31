const form = document.getElementById("task-form");
const message = document.getElementById("message");
const connectionStatus = document.getElementById("connectionStatus");
const mappingStatus = document.getElementById("mappingStatus");
const openOptionsButton = document.getElementById("openOptions");
const submitButton = document.getElementById("submitButton");
const syncButton = document.getElementById("syncTasks");
const notionTasksContainer = document.getElementById("notionTasks");
const googleTasksContainer = document.getElementById("googleTasks");
const notionCount = document.getElementById("notionCount");
const googleCount = document.getElementById("googleCount");
const tabButtons = Array.from(document.querySelectorAll(".tab-button"));
const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));

initialize();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("", "");
  setLoading(true);

  const formData = new FormData(form);
  const payload = {
    title: String(formData.get("title") || ""),
    notes: String(formData.get("notes") || ""),
    dueDate: String(formData.get("dueDate") || ""),
    destinations: {
      notion: document.getElementById("sendNotion").checked,
      googleTasks: document.getElementById("sendGoogleTasks").checked
    }
  };

  try {
    const response = await chrome.runtime.sendMessage({
      type: "create-task",
      payload
    });

    if (!response?.ok) {
      throw new Error(response?.error || "No se pudo crear la tarea.");
    }

    const warnings = response.result.errors?.length
      ? ` Avisos: ${response.result.errors.join(" ")}`
      : "";

    form.reset();
    document.getElementById("sendNotion").checked = true;
    document.getElementById("sendGoogleTasks").checked = true;
    setMessage(`Tarea creada correctamente.${warnings}`, "success");
    await refreshDashboard();
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setLoading(false);
  }
});

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activateTab(button.dataset.target);
  });
});

syncButton.addEventListener("click", async () => {
  setMessage("Sincronizando tareas...", "");
  syncButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: "sync-tasks" });
    if (!response?.ok) {
      throw new Error(response?.error || "No se pudo sincronizar.");
    }

    const summary = response.summary;
    setMessage(
      `Sync lista. Notion +${summary.createdInNotion}, Google +${summary.createdInGoogle}, actualizadas Notion ${summary.updatedInNotion}, actualizadas Google ${summary.updatedInGoogle}, enlazadas ${summary.linkedExisting}, conflictos ${summary.conflicts}.`,
      "success"
    );
    await refreshDashboard();
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    syncButton.disabled = false;
  }
});

async function initialize() {
  await refreshDashboard();
}

async function refreshDashboard() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-dashboard" });
    if (!response?.ok) {
      throw new Error(response?.error || "No se pudo leer el panel.");
    }

    const { status, mappingsCount, notionTasks, googleTasks, syncStatus } = response.dashboard;
    connectionStatus.textContent = [
      `Notion: ${status.notionConfigured ? "listo" : "pendiente"}`,
      `Google config: ${status.googleConfigured ? "lista" : "pendiente"}`,
      `Google auth: ${status.googleAuthenticated ? "activa" : "pendiente"}`,
      `Auto-sync: ${status.autoSyncEnabled ? `cada ${status.autoSyncMinutes}m` : "apagado"}`
    ].join(" | ");
    mappingStatus.textContent = buildMappingStatus(mappingsCount, status, syncStatus);

    notionCount.textContent = String(notionTasks.length);
    googleCount.textContent = String(googleTasks.length);
    renderTaskList(notionTasksContainer, notionTasks, "No hay tareas de Notion disponibles.");
    renderTaskList(googleTasksContainer, googleTasks, "No hay tareas de Google Tasks disponibles.");
  } catch (error) {
    connectionStatus.textContent = error.message;
  }
}

function renderTaskList(container, tasks, emptyMessage) {
  container.textContent = "";

  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyMessage;
    container.appendChild(empty);
    return;
  }

  tasks.slice(0, 6).forEach((task) => {
    const article = document.createElement("article");
    article.className = `task-item ${task.completed ? "done" : ""}`.trim();

    const titleRow = document.createElement("div");
    titleRow.className = "task-heading";

    const title = document.createElement("strong");
    title.textContent = task.title || "(sin titulo)";

    const state = document.createElement("span");
    state.className = `task-state ${task.completed ? "done" : "open"}`;
    state.textContent = task.completed ? "Hecha" : "Activa";

    titleRow.appendChild(title);
    titleRow.appendChild(state);

    const meta = document.createElement("p");
    meta.className = "task-meta";
    meta.textContent = task.dueDate ? formatDate(task.dueDate) : "Sin fecha";

    article.appendChild(titleRow);
    article.appendChild(meta);

    if (task.notes) {
      const notes = document.createElement("p");
      notes.className = "task-notes";
      notes.textContent = task.notes;
      article.appendChild(notes);
    }

    container.appendChild(article);
  });
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "Fecha invalida";
  }

  return new Intl.DateTimeFormat("es", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Creando..." : "Crear tarea";
}

function setMessage(text, type) {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

function buildMappingStatus(mappingsCount, status, syncStatus) {
  const parts = [`${mappingsCount} enlaces`];
  parts.push(`modo ${translateStrategy(status.conflictStrategy)}`);

  if (syncStatus?.lastError) {
    parts.push("ultimo intento con error");
  } else if (syncStatus?.lastRunAt) {
    parts.push(`sync ${formatRelative(syncStatus.lastRunAt)}`);
  }

  return parts.join(" · ");
}

function translateStrategy(strategy) {
  if (strategy === "notion") {
    return "prioriza Notion";
  }

  if (strategy === "google") {
    return "prioriza Google";
  }

  return "manual";
}

function activateTab(targetId) {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.target === targetId;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.id === targetId;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });
}

function formatRelative(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "reciente";
  }

  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes <= 1) {
    return "hace 1 min";
  }

  if (minutes < 60) {
    return `hace ${minutes} min`;
  }

  const hours = Math.round(minutes / 60);
  return `hace ${hours} h`;
}
