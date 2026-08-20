const chatList = document.querySelector("#chat-list");
const chatView = document.querySelector("#chat-view");
const chatEntries = document.querySelector("#chat-entries");
const newChatForm = document.querySelector("#new-chat-form");
const projectSelect = document.querySelector("#project-select");
const backToChats = document.querySelector("#back-to-chats");
const chatTitle = document.querySelector("#chat-title");
const stateElement = document.querySelector("#state");
const timeline = document.querySelector("#timeline");
const scrollToBottomButton = document.querySelector("#scroll-to-bottom");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message");
const sendButton = document.querySelector("#send");
const cancelButton = document.querySelector("#cancel");
const errorElement = document.querySelector("#error");
const modelButton = document.querySelector("#model-button");
const modelDialog = document.querySelector("#model-dialog");
const modelSelect = document.querySelector("#model-select");
const saveModelButton = document.querySelector("#save-model");
let streamingMessage;
let autoScrollTimeline = true;
let activeChatId;
let chatViewGeneration = 0;

function assertElement(element, selector) {
  if (!element) {
    throw new Error(`Required element not found: ${selector}`);
  }
  return element;
}

assertElement(chatList, "#chat-list");
assertElement(chatView, "#chat-view");
assertElement(chatEntries, "#chat-entries");
assertElement(newChatForm, "#new-chat-form");
assertElement(projectSelect, "#project-select");
assertElement(backToChats, "#back-to-chats");
assertElement(chatTitle, "#chat-title");
assertElement(stateElement, "#state");
assertElement(timeline, "#timeline");
assertElement(scrollToBottomButton, "#scroll-to-bottom");
assertElement(composer, "#composer");
assertElement(messageInput, "#message");
assertElement(sendButton, "#send");
assertElement(cancelButton, "#cancel");
assertElement(errorElement, "#error");
assertElement(modelButton, "#model-button");
assertElement(modelDialog, "#model-dialog");
assertElement(modelSelect, "#model-select");
assertElement(saveModelButton, "#save-model");

function scrollTimelineToBottom(behavior = "auto") {
  timeline.scrollTo({ top: timeline.scrollHeight, behavior });
}

function releasePinnedDeploymentCandidate() {
  const card = document.querySelector('.deployment-candidate[data-pinned="true"]');
  if (!card) {
    return;
  }
  card.querySelector("details").open = false;
  delete card.dataset.pinned;
}

function appendTimelineElement(element, role) {
  if (role === "user") {
    releasePinnedDeploymentCandidate();
  }
  const pinnedCard = document.querySelector('.deployment-candidate[data-pinned="true"]');
  if (pinnedCard && role !== "user") {
    timeline.insertBefore(element, pinnedCard);
  } else {
    timeline.append(element);
  }
}

function updateScrollToBottomButton() {
  const distanceFromBottom = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
  const isFarFromBottom = timeline.clientHeight > 0 && distanceFromBottom > timeline.clientHeight;
  scrollToBottomButton.hidden = !isFarFromBottom;
  autoScrollTimeline = distanceFromBottom <= 32;
}

timeline.addEventListener("scroll", updateScrollToBottomButton);
scrollToBottomButton.addEventListener("click", () => {
  autoScrollTimeline = true;
  scrollTimelineToBottom();
  updateScrollToBottomButton();
});

function setState(state) {
  stateElement.textContent = state[0].toUpperCase() + state.slice(1);
  stateElement.dataset.state = state;
  sendButton.disabled = state === "running" || state === "cancelling" || state === "starting";
  cancelButton.disabled = state !== "running";
  cancelButton.hidden = state !== "running";
}

function renderContent(container, content) {
  container.replaceChildren();
  const pattern = /(https?:\/\/[^\s]+|\/api\/artifacts\/screenshot-[0-9]+-[0-9a-f-]{36}\.png)/g;
  let offset = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > offset) {
      container.append(document.createTextNode(content.slice(offset, index)));
    }
    const target = match[0];
    const link = document.createElement("a");
    link.href = target;
    link.textContent = target;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    container.append(link);
    if (target.startsWith("/api/artifacts/")) {
      const image = document.createElement("img");
      image.className = "screenshot";
      image.src = target;
      image.alt = "Agent Outpost screenshot";
      image.loading = "lazy";
      container.append(image);
    }
    offset = index + target.length;
  }
  if (offset < content.length) {
    container.append(document.createTextNode(content.slice(offset)));
  }
}

function appendArtifactMessage(role, artifact, createdAt) {
  const article = document.createElement("article");
  article.className = "message";
  article.dataset.role = role;
  const metadata = document.createElement("small");
  metadata.textContent = `${role === "user" ? "You" : "Agent"} · ${new Date(createdAt).toLocaleTimeString()}`;
  const caption = document.createElement("div");
  caption.textContent = artifact.caption;
  const image = document.createElement("img");
  image.className = "screenshot";
  image.src = artifact.url;
  image.alt = artifact.caption;
  image.loading = "lazy";
  const link = document.createElement("a");
  link.href = artifact.absoluteUrl || artifact.url;
  link.textContent = "Open full image";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  article.append(metadata, caption, image, link);
  appendTimelineElement(article, "assistant");
  if (autoScrollTimeline) {
    scrollTimelineToBottom();
  }
}

function appendDeploymentCandidate(candidate) {
  const article = document.createElement("article");
  article.className = "message deployment-candidate";
  article.dataset.role = "assistant";
  article.dataset.candidateId = candidate.candidateId;
  const details = document.createElement("details");
  details.open = candidate.status === "pending";
  if (candidate.status === "pending") {
    article.dataset.pinned = "true";
  }
  const summary = document.createElement("summary");
  const title = document.createElement("h2");
  title.textContent = `${candidate.projectName || "Agent Outpost"} deployment candidate`;
  summary.append(title);
  const description = document.createElement("p");
  description.textContent = candidate.description;
  const commitSummary = document.createElement("p");
  commitSummary.textContent = `${candidate.commitSha} · ${candidate.files.length} modified file${candidate.files.length === 1 ? "" : "s"}`;
  const files = document.createElement("ul");
  candidate.files.forEach((file) => {
    const item = document.createElement("li");
    item.textContent = `${file.path} (+${file.added}/-${file.removed})`;
    files.append(item);
  });
  const diff = document.createElement("a");
  diff.href = candidate.diffUrl;
  diff.textContent = "View full diff";
  diff.target = "_blank";
  diff.rel = "noopener noreferrer";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = candidate.status === "pending" ? "Deploy" : candidate.status[0].toUpperCase() + candidate.status.slice(1);
  button.disabled = candidate.status !== "pending";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Approving…";
    try {
      await request(`/api/deployment-candidates/${encodeURIComponent(candidate.candidateId)}/approve`, { method: "POST" });
      details.open = false;
    } catch (error) {
      button.disabled = false;
      button.textContent = "Deploy";
      errorElement.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  const content = document.createElement("div");
  content.append(description, commitSummary, files, diff, button);
  details.append(summary, content);
  article.append(details);
  appendTimelineElement(article, "assistant");
  if (autoScrollTimeline) scrollTimelineToBottom();
}

function appendMessage(role, content, createdAt, allowEmpty = false) {
  if (!allowEmpty && role !== "user" && !content.trim()) {
    return;
  }

  const article = document.createElement("article");
  article.className = "message";
  article.dataset.role = role;
  const metadata = document.createElement("small");
  metadata.textContent = `${role === "user" ? "You" : role === "error" ? "Error" : "Agent"} · ${new Date(createdAt).toLocaleTimeString()}`;
  const text = document.createElement("div");
  renderContent(text, content);
  article.append(metadata, text);
  appendTimelineElement(article, role);
  if (autoScrollTimeline) {
    scrollTimelineToBottom();
  }
  return { article, text };
}

function handleEvent(event) {
  switch (event.kind) {
    case "user.message":
      appendMessage("user", event.payload.content, event.createdAt);
      break;
    case "assistant.message":
      if (streamingMessage) {
        const { article, text } = streamingMessage;
        renderContent(text, event.payload.content);
        article.classList.remove("message-working");
        article.classList.add("message-replaced");
        window.setTimeout(() => article.classList.remove("message-replaced"), 280);
        streamingMessage = undefined;
      } else {
        appendMessage("assistant", event.payload.content, event.createdAt);
      }
      break;
    case "assistant.delta":
      if (!streamingMessage) {
        streamingMessage = appendMessage("assistant", "Working…", event.createdAt);
        streamingMessage.article.classList.add("message-working");
      }
      if (autoScrollTimeline) {
        scrollTimelineToBottom();
      }
      break;
    case "session.state":
      setState(event.payload.state);
      break;
    case "session.error":
      appendMessage("error", event.payload.message, event.createdAt);
      break;
    case "system.notice":
      appendMessage("assistant", event.payload.message, event.createdAt);
      break;
    case "assistant.artifact":
      appendArtifactMessage("assistant", event.payload, event.createdAt);
      break;
    case "deployment.candidate":
      document.querySelector(`[data-candidate-id="${CSS.escape(event.payload.candidateId)}"]`)?.remove();
      appendDeploymentCandidate(event.payload, event.createdAt);
      break;
  }
}

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed with status ${response.status}`);
  }
  return body;
}

let eventSource;

function formatLastUsed(value) {
  if (!value) {
    return "Never used";
  }
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatChatStatistics(statistics) {
  const firstMessage = statistics.firstMessageAt
    ? formatLastUsed(statistics.firstMessageAt)
    : `No messages yet (created ${formatLastUsed(statistics.createdAt)})`;
  return [
    `Messages: ${statistics.messageCount}`,
    `Estimated tokens: ${statistics.estimatedTokens.toLocaleString()}`,
    `AIC usage: ${statistics.aicUsage}`,
    `First message: ${firstMessage}`,
  ].join("\n");
}

function renderChatEntry(chat) {
  const row = document.createElement("div");
  row.className = "chat-row";

  const button = document.createElement("button");
  button.className = "chat-entry";
  button.type = "button";
  const title = document.createElement("strong");
  title.textContent = chat.name;
  const repository = document.createElement("span");
  repository.textContent = `${chat.projectName} · ${chat.repository}`;
  const lastUsed = document.createElement("small");
  lastUsed.textContent = `Last used ${formatLastUsed(chat.lastUsedAt)}`;
  button.append(title, repository, lastUsed);
  button.addEventListener("click", () => void openChat(chat));

  const controls = document.createElement("div");
  controls.className = "chat-controls";

  const rename = document.createElement("button");
  rename.className = "chat-control";
  rename.type = "button";
  rename.innerHTML = '<span class="codicon codicon-edit" aria-hidden="true">✎</span>';
  rename.setAttribute("aria-label", `Rename ${chat.name}`);
  rename.title = "Rename chat";

  const info = document.createElement("button");
  info.className = "chat-control";
  info.type = "button";
  info.innerHTML = '<span class="codicon codicon-info" aria-hidden="true">ⓘ</span>';
  info.setAttribute("aria-label", `Show details for ${chat.name}`);
  info.title = "Show chat details";
  info.addEventListener("click", async () => {
    errorElement.textContent = "";
    try {
      const response = await request(`/api/chats/${encodeURIComponent(chat.id)}/statistics`);
      details.textContent = formatChatStatistics(response.statistics);
      details.hidden = false;
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  const remove = document.createElement("button");
  remove.className = "chat-control chat-delete";
  remove.type = "button";
  remove.innerHTML = '<span class="codicon codicon-trash" aria-hidden="true">🗑</span>';
  remove.setAttribute("aria-label", `Delete ${chat.name}`);
  remove.title = "Delete chat";
  remove.addEventListener("click", async () => {
    errorElement.textContent = "";
    if (!confirm(`Delete the ${chat.projectName} chat? This cannot be undone.`)) {
      return;
    }
    try {
      await request(`/api/chats/${encodeURIComponent(chat.id)}`, { method: "DELETE" });
      await loadChats();
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  const details = document.createElement("pre");
  details.className = "chat-details";
  details.hidden = true;

  const renameForm = document.createElement("form");
  renameForm.className = "chat-rename";
  renameForm.hidden = true;
  const renameInput = document.createElement("input");
  renameInput.type = "text";
  renameInput.value = chat.name;
  renameInput.maxLength = 100;
  renameInput.required = true;
  renameInput.setAttribute("aria-label", `Name for ${chat.name}`);
  const saveRename = document.createElement("button");
  saveRename.type = "submit";
  saveRename.textContent = "Save";
  const cancelRename = document.createElement("button");
  cancelRename.type = "button";
  cancelRename.className = "secondary";
  cancelRename.textContent = "Cancel";
  renameForm.append(renameInput, saveRename, cancelRename);

  rename.addEventListener("click", () => {
    renameForm.hidden = false;
    button.hidden = true;
    controls.hidden = true;
    renameInput.focus();
    renameInput.select();
  });
  cancelRename.addEventListener("click", () => {
    renameForm.hidden = true;
    button.hidden = false;
    controls.hidden = false;
  });
  renameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorElement.textContent = "";
    controls.hidden = false;
    try {
      await request(`/api/chats/${encodeURIComponent(chat.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameInput.value }),
      });
      await loadChats();
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  controls.append(rename, info, remove);
  row.append(button, controls, renameForm, details);
  return row;
}

async function loadChats() {
  const response = await request("/api/chats");
  chatEntries.replaceChildren(...response.chats.map(renderChatEntry));
}

async function loadProjects() {
  const response = await request("/api/projects");
  projectSelect.replaceChildren(
    new Option("Select a project", ""),
    ...response.projects.map(
      (project) => new Option(`${project.name} · ${project.repository}`, project.id),
    ),
  );
}

function closeEvents() {
  eventSource?.close();
  eventSource = undefined;
}

function showChatView() {
  chatList.hidden = true;
  chatView.hidden = false;
}

function scrollTimelineAfterLayout() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      autoScrollTimeline = true;
      scrollTimelineToBottom();
      updateScrollToBottomButton();
    });
  });
}

function showChatList() {
  chatViewGeneration += 1;
  closeEvents();
  chatView.hidden = true;
  chatList.hidden = false;
  void loadChats();
}

async function openChat(chat) {
  const generation = chatViewGeneration + 1;
  chatViewGeneration = generation;
  activeChatId = chat.id;
  await request(`/api/chats/${encodeURIComponent(chat.id)}/select`, { method: "POST" });
  if (generation !== chatViewGeneration || activeChatId !== chat.id) {
    return;
  }
  showChatView();
  chatTitle.textContent = `${chat.name} · ${chat.projectName}`;
  autoScrollTimeline = true;
  const snapshot = await loadSession(chat.id);
  if (generation !== chatViewGeneration || activeChatId !== chat.id) {
    return;
  }
  timeline.replaceChildren();
  snapshot.events.forEach(handleEvent);
  setState(snapshot.state);
  autoScrollTimeline = true;
  scrollTimelineAfterLayout();
  connectEvents(snapshot.events.at(-1)?.id || 0, chat.id);
}

async function loadSession(chatId) {
  const scenario = new URLSearchParams(window.location.search).get("scenario");
  const params = new URLSearchParams({ chatId });
  if (scenario) {
    params.set("scenario", scenario);
  }
  return request(`/api/session?${params}`);
}

function connectEvents(after, chatId) {
  closeEvents();
  eventSource = new EventSource(`/api/session/events?after=${after}&chatId=${encodeURIComponent(chatId)}`);
  const source = eventSource;
  const types = [
    "user.message",
    "assistant.message",
    "assistant.delta",
    "assistant.artifact",
    "session.state",
    "session.error",
    "system.notice",
    "deployment.candidate",
  ];
  types.forEach((type) => {
    source.addEventListener(type, (message) => {
      if (activeChatId === chatId) {
        handleEvent(JSON.parse(message.data));
      }
    });
  });
  source.onerror = () => {
    if (activeChatId === chatId) {
      errorElement.textContent = "Live updates disconnected; reconnecting…";
    }
  };
  source.onopen = () => {
    if (activeChatId === chatId) {
      errorElement.textContent = "";
    }
  };
}

async function loadModel() {
  const response = await request("/api/model");
  modelButton.textContent = response.model;
  modelSelect.replaceChildren(...response.models.map((model) => new Option(model, model)));
  modelSelect.value = response.model;
}

modelButton.addEventListener("click", () => modelDialog.showModal());
saveModelButton.addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    const response = await request("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelSelect.value }),
    });
    modelButton.textContent = response.model;
    modelDialog.close();
  } catch (error) {
    errorElement.textContent = error instanceof Error ? error.message : String(error);
  }
});

async function loadResources() {
  try {
    const resources = await request("/api/status/resources");
    document.querySelector("#cpu").textContent = `${resources.cpu.usagePercent}%`;
    document.querySelector("#memory").textContent = `${resources.memory.usagePercent}%`;
    document.querySelector("#disk").textContent = `${resources.disk.usagePercent}%`;
    document.querySelector("#load").textContent = resources.loadAverage[0].toFixed(2);
    document.querySelector("#last-deployment").textContent = formatLastUsed(resources.lastDeploymentAt);
  } catch (error) {
    errorElement.textContent = error instanceof Error ? error.message : String(error);
  }
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorElement.textContent = "";
  autoScrollTimeline = true;
  scrollTimelineToBottom();
  try {
    await request(`/api/session/messages?chatId=${encodeURIComponent(activeChatId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: messageInput.value }),
    });
    messageInput.value = "";
  } catch (error) {
    errorElement.textContent = error instanceof Error ? error.message : String(error);
  }
});

cancelButton.addEventListener("click", async () => {
  errorElement.textContent = "";
  try {
    await request(`/api/session/cancel?chatId=${encodeURIComponent(activeChatId)}`, { method: "POST" });
  } catch (error) {
    errorElement.textContent = error instanceof Error ? error.message : String(error);
  }
});

backToChats.addEventListener("click", showChatList);
newChatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorElement.textContent = "";
  const projectId = projectSelect.value;
  if (!projectId) {
    errorElement.textContent = "Select a project first";
    return;
  }
  try {
    const response = await request("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    await openChat(response.chat);
  } catch (error) {
    errorElement.textContent = error instanceof Error ? error.message : String(error);
  }
});
await loadChats();
void loadProjects().catch((error) => {
  projectSelect.replaceChildren(new Option("Projects unavailable", ""));
  errorElement.textContent = error instanceof Error ? error.message : String(error);
});
loadResources();
void loadModel().catch((error) => {
  errorElement.textContent = error instanceof Error ? error.message : String(error);
});
setInterval(() => void loadResources(), 10_000);
