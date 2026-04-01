const NOTION_VERSION = "2022-06-28";
const GOOGLE_TASKS_API = "https://www.googleapis.com/tasks/v1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAPPINGS_KEY = "taskMappings";
const SYNC_STATUS_KEY = "syncStatus";
const AUTO_SYNC_ALARM = "auto-sync";

chrome.runtime.onInstalled.addListener(() => {
  configureAutoSync().catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  configureAutoSync().catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_SYNC_ALARM) {
    return;
  }

  syncTasks("auto").catch(async (error) => {
    await saveSyncStatus({
      lastRunAt: new Date().toISOString(),
      lastRunMode: "auto",
      lastError: error.message,
      lastSummary: null
    });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "create-task") {
    handleCreateTask(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "google-auth") {
    authorizeGoogle()
      .then((token) => sendResponse({ ok: true, token }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "google-signout") {
    revokeGoogleToken()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-status") {
    getStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-dashboard") {
    getDashboardData()
      .then((dashboard) => sendResponse({ ok: true, dashboard }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "sync-tasks") {
    syncTasks("manual")
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "sync-config-updated") {
    configureAutoSync()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "validate-connections") {
    validateConnections()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function handleCreateTask(payload) {
  const config = await getStoredConfig();
  validateTaskPayload(payload);

  const notionRequested = Boolean(payload.destinations?.notion);
  const googleRequested = Boolean(payload.destinations?.googleTasks);

  if (!notionRequested && !googleRequested) {
    throw new Error("Selecciona al menos un destino.");
  }

  const results = {};
  const errors = [];

  if (notionRequested) {
    try {
      results.notion = await createNotionTask(payload, config.notion);
    } catch (error) {
      errors.push(`Notion: ${error.message}`);
    }
  }

  if (googleRequested) {
    try {
      results.googleTasks = await createGoogleTask(payload, config.google);
    } catch (error) {
      errors.push(`Google Tasks: ${error.message}`);
    }
  }

  if (results.notion && results.googleTasks) {
    await upsertMapping({
      notionId: results.notion.id,
      googleTaskId: results.googleTasks.id,
      notionEditedTime: results.notion.lastEditedTime || results.notion.updatedAt || "",
      googleUpdated: results.googleTasks.updated || ""
    });
  }

  if (errors.length > 0 && Object.keys(results).length === 0) {
    throw new Error(errors.join(" | "));
  }

  return { results, errors };
}

async function getDashboardData() {
  const [status, mappings, notionTasks, googleTasks, syncStatus] = await Promise.all([
    getStatus(),
    getMappings(),
    listNotionTasksSafe(),
    listGoogleTasksSafe(),
    getSyncStatus()
  ]);

  return {
    status,
    mappingsCount: mappings.length,
    notionTasks,
    googleTasks,
    syncStatus
  };
}

async function syncTasks(mode = "manual") {
  const [config, notionTasks, googleTasks, mappings] = await Promise.all([
    getStoredConfig(),
    listNotionTasks(),
    listGoogleTasks(),
    getMappings()
  ]);

  const notionById = new Map(notionTasks.map((task) => [task.id, task]));
  const googleById = new Map(googleTasks.map((task) => [task.id, task]));
  const summary = {
    createdInNotion: 0,
    createdInGoogle: 0,
    updatedInNotion: 0,
    updatedInGoogle: 0,
    linkedExisting: 0,
    conflicts: 0,
    skipped: 0
  };

  const mappingIndex = new Map();
  for (const mapping of mappings) {
    if (mapping.notionId && mapping.googleTaskId) {
      mappingIndex.set(`${mapping.notionId}::${mapping.googleTaskId}`, mapping);
    }
  }

  for (const notionTask of notionTasks) {
    if (notionTask.completed) {
      continue;
    }

    const existingMapping = mappings.find((item) => item.notionId === notionTask.id);
    if (!existingMapping) {
      continue;
    }

    const googleTask = googleById.get(existingMapping.googleTaskId);
    if (!googleTask) {
      const created = await createGoogleTask(notionTask, config.google);
      await upsertMapping({
        notionId: notionTask.id,
        googleTaskId: created.id,
        notionEditedTime: notionTask.updatedAt,
        googleUpdated: created.updated
      });
      googleById.set(created.id, created);
      summary.createdInGoogle += 1;
      continue;
    }

    const notionChanged = notionTask.updatedAt && notionTask.updatedAt !== existingMapping.notionEditedTime;
    const googleChanged = googleTask.updated && googleTask.updated !== existingMapping.googleUpdated;

    if (notionChanged && !googleChanged) {
      const updated = await updateGoogleTask(googleTask.id, notionTask, config.google);
      await upsertMapping({
        notionId: notionTask.id,
        googleTaskId: googleTask.id,
        notionEditedTime: notionTask.updatedAt,
        googleUpdated: updated.updated
      });
      googleById.set(updated.id, updated);
      summary.updatedInGoogle += 1;
      continue;
    }

    if (googleChanged && !notionChanged) {
      const updated = await updateNotionTask(notionTask.id, googleTask, config.notion);
      await upsertMapping({
        notionId: notionTask.id,
        googleTaskId: googleTask.id,
        notionEditedTime: updated.lastEditedTime,
        googleUpdated: googleTask.updated
      });
      notionById.set(updated.id, updated);
      summary.updatedInNotion += 1;
      continue;
    }

    if (googleChanged && notionChanged) {
      const resolution = await resolveConflict(notionTask, googleTask, existingMapping, config);
      if (resolution === "notion") {
        const updated = await updateGoogleTask(googleTask.id, notionTask, config.google);
        await upsertMapping({
          notionId: notionTask.id,
          googleTaskId: googleTask.id,
          notionEditedTime: notionTask.updatedAt,
          googleUpdated: updated.updated
        });
        googleById.set(updated.id, updated);
        summary.updatedInGoogle += 1;
      } else if (resolution === "google") {
        const updated = await updateNotionTask(notionTask.id, googleTask, config.notion);
        await upsertMapping({
          notionId: notionTask.id,
          googleTaskId: googleTask.id,
          notionEditedTime: updated.lastEditedTime,
          googleUpdated: googleTask.updated
        });
        notionById.set(updated.id, updated);
        summary.updatedInNotion += 1;
      } else {
        summary.conflicts += 1;
      }
    }
  }

  const unmappedNotion = notionTasks.filter((task) => !mappings.some((item) => item.notionId === task.id) && !task.completed);
  const unmappedGoogle = googleTasks.filter((task) => !mappings.some((item) => item.googleTaskId === task.id) && task.status !== "completed");

  const notionSignatureIndex = new Map(unmappedNotion.map((task) => [buildTaskSignature(task), task]));
  const googleSignatureIndex = new Map(unmappedGoogle.map((task) => [buildTaskSignature(task), task]));

  for (const notionTask of unmappedNotion) {
    const matchedGoogle = googleSignatureIndex.get(buildTaskSignature(notionTask));
    if (matchedGoogle) {
      await upsertMapping({
        notionId: notionTask.id,
        googleTaskId: matchedGoogle.id,
        notionEditedTime: notionTask.updatedAt,
        googleUpdated: matchedGoogle.updated
      });
      googleSignatureIndex.delete(buildTaskSignature(notionTask));
      summary.linkedExisting += 1;
      continue;
    }

    const created = await createGoogleTask(notionTask, config.google);
    await upsertMapping({
      notionId: notionTask.id,
      googleTaskId: created.id,
      notionEditedTime: notionTask.updatedAt,
      googleUpdated: created.updated
    });
    summary.createdInGoogle += 1;
  }

  for (const googleTask of unmappedGoogle) {
    const signature = buildTaskSignature(googleTask);
    if (!googleSignatureIndex.has(signature)) {
      continue;
    }

    const matchedNotion = notionSignatureIndex.get(signature);
    if (matchedNotion) {
      await upsertMapping({
        notionId: matchedNotion.id,
        googleTaskId: googleTask.id,
        notionEditedTime: matchedNotion.updatedAt,
        googleUpdated: googleTask.updated
      });
      notionSignatureIndex.delete(signature);
      summary.linkedExisting += 1;
      continue;
    }

    const created = await createNotionTask(googleTask, config.notion);
    await upsertMapping({
      notionId: created.id,
      googleTaskId: googleTask.id,
      notionEditedTime: created.lastEditedTime || created.updatedAt || "",
      googleUpdated: googleTask.updated
    });
    summary.createdInNotion += 1;
  }

  await saveSyncStatus({
    lastRunAt: new Date().toISOString(),
    lastRunMode: mode,
    lastError: "",
    lastSummary: summary
  });

  return summary;
}

async function getStatus() {
  const config = await getStoredConfig();
  const googleToken = await getGoogleToken(false).catch(() => null);
  const mappings = await getMappings();
  const syncStatus = await getSyncStatus();

  return {
    notionConfigured: Boolean(config.notion.token && config.notion.databaseId),
    googleConfigured: Boolean(config.google.clientId),
    googleAuthenticated: Boolean(googleToken?.access_token),
    mappingsCount: mappings.length,
    autoSyncEnabled: Boolean(config.sync.autoSyncEnabled),
    autoSyncMinutes: config.sync.autoSyncMinutes,
    conflictStrategy: config.sync.conflictStrategy,
    lastRunAt: syncStatus.lastRunAt,
    lastRunError: syncStatus.lastError
  };
}

async function validateConnections() {
  const [config, googleTokenResult] = await Promise.all([
    getStoredConfig(),
    getGoogleToken(false)
      .then((token) => ({ token, error: "" }))
      .catch((error) => ({ token: null, error: error.message }))
  ]);

  const notion = await validateNotionConnection(config.notion);
  const google = await validateGoogleConnection(config.google, googleTokenResult.token, googleTokenResult.error);

  return {
    checkedAt: new Date().toISOString(),
    notion,
    google,
    allHealthy: notion.ok && google.ok
  };
}

async function getStoredConfig() {
  const data = await chrome.storage.sync.get({
    notionToken: "",
    notionDatabaseId: "",
    notionTitleProperty: "Name",
    notionNotesProperty: "Notes",
    notionDueDateProperty: "Due",
    notionCompletedProperty: "",
    googleClientId: "",
    googleClientSecret: "",
    googleTaskListId: "@default",
    autoSyncEnabled: false,
    autoSyncMinutes: 15,
    conflictStrategy: "manual"
  });

  return {
    notion: {
      token: data.notionToken,
      databaseId: data.notionDatabaseId,
      titleProperty: data.notionTitleProperty,
      notesProperty: data.notionNotesProperty,
      dueDateProperty: data.notionDueDateProperty,
      completedProperty: data.notionCompletedProperty
    },
    google: {
      clientId: data.googleClientId,
      clientSecret: data.googleClientSecret,
      taskListId: data.googleTaskListId
    },
    sync: {
      autoSyncEnabled: Boolean(data.autoSyncEnabled),
      autoSyncMinutes: normalizeAutoSyncMinutes(data.autoSyncMinutes),
      conflictStrategy: normalizeConflictStrategy(data.conflictStrategy)
    }
  };
}

function validateTaskPayload(payload) {
  if (!payload?.title?.trim()) {
    throw new Error("El titulo de la tarea es obligatorio.");
  }
}

async function listNotionTasksSafe() {
  try {
    return await listNotionTasks();
  } catch {
    return [];
  }
}

async function listGoogleTasksSafe() {
  try {
    return await listGoogleTasks();
  } catch {
    return [];
  }
}

async function listNotionTasks() {
  const config = await getStoredConfig();
  if (!config.notion.token || !config.notion.databaseId) {
    return [];
  }

  const response = await fetch(`https://api.notion.com/v1/databases/${config.notion.databaseId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.notion.token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION
    },
    body: JSON.stringify({
      page_size: 25,
      sorts: [
        {
          timestamp: "last_edited_time",
          direction: "descending"
        }
      ]
    })
  });

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.message || "No se pudieron leer las tareas de Notion.");
  }

  const data = await response.json();
  return data.results.map((item) => normalizeNotionTask(item, config.notion));
}

async function validateNotionConnection(notionConfig) {
  if (!notionConfig.token || !notionConfig.databaseId) {
    return {
      ok: false,
      status: "missing_config",
      label: "Not configured",
      detail: "Add both the Notion integration token and database ID."
    };
  }

  const response = await fetch(`https://api.notion.com/v1/databases/${notionConfig.databaseId}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${notionConfig.token}`,
      "Notion-Version": NOTION_VERSION
    }
  });

  const data = await safeJson(response);
  if (!response.ok) {
    return {
      ok: false,
      status: "error",
      label: "Connection failed",
      detail: data?.message || "Could not access the Notion database."
    };
  }

  return {
    ok: true,
    status: "connected",
    label: "Connected",
    detail: data?.title?.map((part) => part.plain_text || "").join("") || "Notion database is reachable."
  };
}

async function createNotionTask(task, notionConfig) {
  if (!notionConfig.token || !notionConfig.databaseId) {
    throw new Error("Falta configurar el token o database ID de Notion.");
  }

  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${notionConfig.token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION
    },
    body: JSON.stringify({
      parent: {
        database_id: notionConfig.databaseId
      },
      properties: buildNotionProperties(task, notionConfig)
    })
  });

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.message || "No se pudo crear la tarea en Notion.");
  }

  const data = await response.json();
  return normalizeNotionTask(data, notionConfig);
}

async function updateNotionTask(pageId, task, notionConfig) {
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${notionConfig.token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION
    },
    body: JSON.stringify({
      properties: buildNotionProperties(task, notionConfig)
    })
  });

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.message || "No se pudo actualizar la tarea en Notion.");
  }

  const data = await response.json();
  return normalizeNotionTask(data, notionConfig);
}

function buildNotionProperties(task, notionConfig) {
  const properties = {
    [notionConfig.titleProperty]: {
      title: [
        {
          text: {
            content: task.title.trim()
          }
        }
      ]
    }
  };

  if (notionConfig.notesProperty) {
    properties[notionConfig.notesProperty] = {
      rich_text: task.notes?.trim()
        ? [
            {
              text: {
                content: task.notes.trim()
              }
            }
          ]
        : []
    };
  }

  if (notionConfig.dueDateProperty) {
    properties[notionConfig.dueDateProperty] = {
      date: task.dueDate
        ? {
            start: new Date(task.dueDate).toISOString()
          }
        : null
    };
  }

  if (notionConfig.completedProperty) {
    properties[notionConfig.completedProperty] = {
      checkbox: Boolean(task.completed)
    };
  }

  return properties;
}

function normalizeNotionTask(item, notionConfig) {
  const titleProperty = item.properties?.[notionConfig.titleProperty];
  const notesProperty = item.properties?.[notionConfig.notesProperty];
  const dueDateProperty = item.properties?.[notionConfig.dueDateProperty];
  const completedProperty = item.properties?.[notionConfig.completedProperty];

  return {
    id: item.id,
    source: "notion",
    title: extractNotionTitle(titleProperty),
    notes: extractNotionRichText(notesProperty),
    dueDate: dueDateProperty?.date?.start || "",
    updatedAt: item.last_edited_time || "",
    lastEditedTime: item.last_edited_time || "",
    completed: completedProperty?.checkbox || false,
    url: item.url || ""
  };
}

async function listGoogleTasks() {
  const config = await getStoredConfig();
  if (!config.google.clientId) {
    return [];
  }

  const tokenInfo = await getGoogleToken(false);
  const response = await fetch(`${GOOGLE_TASKS_API}/lists/${encodeURIComponent(config.google.taskListId)}/tasks?showCompleted=true&maxResults=25`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${tokenInfo.access_token}`
    }
  });

  if (response.status === 401) {
    await clearGoogleToken();
    throw new Error("La sesion de Google expiró. Vuelve a autorizar en Opciones.");
  }

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error?.message || "No se pudieron leer las tareas de Google Tasks.");
  }

  const data = await response.json();
  return (data.items || []).map((item) => normalizeGoogleTask(item));
}

async function validateGoogleConnection(googleConfig, googleToken, tokenError = "") {
  if (!googleConfig.clientId) {
    return {
      ok: false,
      status: "missing_config",
      label: "Not configured",
      detail: "Add the Google OAuth Client ID first."
    };
  }

  if (!googleConfig.clientSecret) {
    return {
      ok: false,
      status: "missing_config",
      label: "Client secret required",
      detail: "Add the Google OAuth Client Secret from Google Cloud."
    };
  }

  if (!googleToken?.access_token) {
    return {
      ok: false,
      status: "needs_auth",
      label: "Authorization required",
      detail: tokenError || "The Google credentials are saved, but authorization is still required."
    };
  }

  const response = await fetch(`${GOOGLE_TASKS_API}/users/@me/lists/${encodeURIComponent(googleConfig.taskListId)}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${googleToken.access_token}`
    }
  });

  const data = await safeJson(response);
  if (response.status === 401) {
    await clearGoogleToken();
    return {
      ok: false,
      status: "needs_auth",
      label: "Authorization expired",
      detail: "Google authorization expired. Please authorize again."
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: "error",
      label: "Connection failed",
      detail: data?.error?.message || "Could not access the selected Google Task list."
    };
  }

  return {
    ok: true,
    status: "connected",
    label: "Connected",
    detail: data?.title || "Google Tasks list is reachable."
  };
}

async function createGoogleTask(task, googleConfig) {
  if (!googleConfig.clientId) {
    throw new Error("Falta configurar el Client ID de Google.");
  }

  if (!googleConfig.clientSecret) {
    throw new Error("Falta configurar el Client Secret de Google.");
  }

  const tokenInfo = await getGoogleToken(true);
  const response = await fetch(`${GOOGLE_TASKS_API}/lists/${encodeURIComponent(googleConfig.taskListId)}/tasks`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${tokenInfo.access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildGoogleTaskPayload(task))
  });

  if (response.status === 401) {
    await clearGoogleToken();
    throw new Error("La sesion de Google expiró. Vuelve a autorizar en Opciones.");
  }

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error?.message || "No se pudo crear la tarea en Google Tasks.");
  }

  const data = await response.json();
  return normalizeGoogleTask(data);
}

async function updateGoogleTask(taskId, task, googleConfig) {
  const tokenInfo = await getGoogleToken(true);
  const response = await fetch(`${GOOGLE_TASKS_API}/lists/${encodeURIComponent(googleConfig.taskListId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${tokenInfo.access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildGoogleTaskPayload(task))
  });

  if (response.status === 401) {
    await clearGoogleToken();
    throw new Error("La sesion de Google expiró. Vuelve a autorizar en Opciones.");
  }

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error?.message || "No se pudo actualizar la tarea en Google Tasks.");
  }

  const data = await response.json();
  return normalizeGoogleTask(data);
}

function buildGoogleTaskPayload(task) {
  return {
    title: task.title.trim(),
    notes: task.notes?.trim() || "",
    due: task.dueDate ? new Date(task.dueDate).toISOString() : undefined,
    status: task.completed ? "completed" : "needsAction"
  };
}

function normalizeGoogleTask(item) {
  return {
    id: item.id,
    source: "google",
    title: item.title || "",
    notes: item.notes || "",
    dueDate: item.due || "",
    updatedAt: item.updated || "",
    updated: item.updated || "",
    completed: item.status === "completed",
    status: item.status || "needsAction",
    url: ""
  };
}

async function authorizeGoogle() {
  const config = await getStoredConfig();
  if (!config.google.clientId) {
    throw new Error("Configura primero el Client ID de Google en la pagina de opciones.");
  }
  if (!config.google.clientSecret) {
    throw new Error("Configura primero el Client Secret de Google en la pagina de opciones.");
  }

  return getGoogleToken(true);
}

async function getGoogleToken(interactive) {
  const stored = await chrome.storage.local.get({
    googleAccessToken: "",
    googleRefreshToken: "",
    googleTokenExpiresAt: 0
  });
  const config = await getStoredConfig();

  if (!config.google.clientId) {
    throw new Error("No hay Client ID configurado.");
  }
  if (!config.google.clientSecret) {
    throw new Error("No hay Client Secret configurado.");
  }

  if (stored.googleAccessToken && stored.googleTokenExpiresAt > Date.now() + 60_000) {
    return {
      access_token: stored.googleAccessToken
    };
  }

  if (stored.googleRefreshToken) {
    return refreshGoogleToken(config.google.clientId, config.google.clientSecret, stored.googleRefreshToken);
  }

  if (!interactive) {
    throw new Error("Google Tasks aun no esta autorizado.");
  }

  return startGoogleOAuth(config.google.clientId, config.google.clientSecret);
}

async function startGoogleOAuth(clientId, clientSecret) {
  const redirectUri = chrome.identity.getRedirectURL("oauth2");
  const codeVerifier = createCodeVerifier();
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");

  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/tasks");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const redirectedTo = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true
  });

  if (!redirectedTo) {
    throw new Error("No se completó la autorizacion de Google.");
  }

  const code = new URL(redirectedTo).searchParams.get("code");
  if (!code) {
    throw new Error("Google no devolvio el codigo de autorizacion.");
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });

  const tokenData = await response.json();
  if (!response.ok) {
    throw new Error(tokenData.error_description || "No se pudo obtener el token de Google.");
  }

  await persistGoogleToken(tokenData);
  return tokenData;
}

async function refreshGoogleToken(clientId, clientSecret, refreshToken) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });

  const data = await response.json();
  if (!response.ok) {
    await clearGoogleToken();
    throw new Error(data.error_description || "No se pudo renovar el token de Google.");
  }

  await persistGoogleToken({
    ...data,
    refresh_token: refreshToken
  });

  return data;
}

async function persistGoogleToken(tokenData) {
  const expiresAt = Date.now() + (Number(tokenData.expires_in || 3600) * 1000);

  await chrome.storage.local.set({
    googleAccessToken: tokenData.access_token,
    googleRefreshToken: tokenData.refresh_token || "",
    googleTokenExpiresAt: expiresAt
  });
}

async function revokeGoogleToken() {
  const stored = await chrome.storage.local.get({
    googleAccessToken: ""
  });

  if (stored.googleAccessToken) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.googleAccessToken)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
  }

  await clearGoogleToken();
}

async function clearGoogleToken() {
  await chrome.storage.local.remove([
    "googleAccessToken",
    "googleRefreshToken",
    "googleTokenExpiresAt"
  ]);
}

async function configureAutoSync() {
  const config = await getStoredConfig();

  await chrome.alarms.clear(AUTO_SYNC_ALARM);
  if (!config.sync.autoSyncEnabled) {
    return;
  }

  chrome.alarms.create(AUTO_SYNC_ALARM, {
    delayInMinutes: config.sync.autoSyncMinutes,
    periodInMinutes: config.sync.autoSyncMinutes
  });
}

async function resolveConflict(notionTask, googleTask, existingMapping, config) {
  const strategy = config.sync.conflictStrategy;
  if (strategy === "notion") {
    return "notion";
  }

  if (strategy === "google") {
    return "google";
  }

  const lastNotionChange = existingMapping.notionEditedTime || "";
  const lastGoogleChange = existingMapping.googleUpdated || "";
  if (notionTask.updatedAt === lastNotionChange && googleTask.updated !== lastGoogleChange) {
    return "google";
  }

  if (googleTask.updated === lastGoogleChange && notionTask.updatedAt !== lastNotionChange) {
    return "notion";
  }

  return "manual";
}

async function getMappings() {
  const data = await chrome.storage.local.get({
    [MAPPINGS_KEY]: []
  });

  return Array.isArray(data[MAPPINGS_KEY]) ? data[MAPPINGS_KEY] : [];
}

async function upsertMapping(nextMapping) {
  const mappings = await getMappings();
  const index = mappings.findIndex((item) =>
    (nextMapping.notionId && item.notionId === nextMapping.notionId) ||
    (nextMapping.googleTaskId && item.googleTaskId === nextMapping.googleTaskId)
  );

  const merged = {
    notionId: "",
    googleTaskId: "",
    notionEditedTime: "",
    googleUpdated: "",
    ...mappings[index],
    ...nextMapping
  };

  if (index >= 0) {
    mappings[index] = merged;
  } else {
    mappings.push(merged);
  }

  await chrome.storage.local.set({
    [MAPPINGS_KEY]: mappings
  });
}

async function getSyncStatus() {
  const data = await chrome.storage.local.get({
    [SYNC_STATUS_KEY]: {
      lastRunAt: "",
      lastRunMode: "",
      lastError: "",
      lastSummary: null
    }
  });

  return data[SYNC_STATUS_KEY];
}

async function saveSyncStatus(status) {
  await chrome.storage.local.set({
    [SYNC_STATUS_KEY]: status
  });
}

function buildTaskSignature(task) {
  return [
    normalizeText(task.title),
    normalizeText(task.notes),
    normalizeDate(task.dueDate)
  ].join("::");
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString().slice(0, 16);
}

function normalizeAutoSyncMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) {
    return 15;
  }

  return Math.max(5, Math.round(minutes));
}

function normalizeConflictStrategy(value) {
  if (value === "notion" || value === "google" || value === "manual") {
    return value;
  }

  return "manual";
}

function extractNotionTitle(property) {
  if (!property?.title?.length) {
    return "";
  }

  return property.title.map((part) => part.plain_text || "").join("");
}

function extractNotionRichText(property) {
  if (!property?.rich_text?.length) {
    return "";
  }

  return property.rich_text.map((part) => part.plain_text || "").join("");
}

function createCodeVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

async function createCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
