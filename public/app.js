const chatList = document.querySelector("#chat-list");
const chatView = document.querySelector("#chat-view");
const chatEntries = document.querySelector("#chat-entries");
const newChatForm = document.querySelector("#new-chat-form");
const repositorySelect = document.querySelector("#repository-select");
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
let streamingMessage;
let autoScrollTimeline = true;

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
assertElement(repositorySelect, "#repository-select");
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

function scrollTimelineToBottom(behavior = "auto") {
  timeline.scrollTo({ top: timeline.scrollHeight, behavior });
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
  timeline.append(article);
  if (autoScrollTimeline) {
    scrollTimelineToBottom();
  }
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
  timeline.append(article);
  if (autoScrollTimeline) {
    scrollTimelineToBottom();
  }
  return text;
}

function handleEvent(event) {
  switch (event.kind) {
    case "user.message":
      appendMessage("user", event.payload.content, event.createdAt);
      break;
    case "assistant.message":
      if (streamingMessage) {
        renderContent(streamingMessage, event.payload.content);
        streamingMessage = undefined;
      } else {
        appendMessage("assistant", event.payload.content, event.createdAt);
      }
      break;
    case "assistant.delta":
      if (!streamingMessage) {
        streamingMessage = appendMessage("assistant", "", event.createdAt, true);
      }
      streamingMessage.append(document.createTextNode(event.payload.content));
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
  repository.textContent = chat.repository;
  const lastUsed = document.createElement("small");
  lastUsed.textContent = `Last used ${formatLastUsed(chat.lastUsedAt)}`;
  button.append(title, repository, lastUsed);
  button.addEventListener("click", () => void openChat(chat));

  const controls = document.createElement("div");
  controls.className = "chat-controls";

  const info = document.createElement("button");
  info.className = "chat-control";
  info.type = "button";
  info.textContent = "Info";
  info.setAttribute("aria-label", `Show details for ${chat.name}`);
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
  remove.textContent = "Delete";
  remove.setAttribute("aria-label", `Delete ${chat.name}`);
  remove.addEventListener("click", async () => {
    errorElement.textContent = "";
    if (!confirm(`Delete the chat for ${chat.repository}? This cannot be undone.`)) {
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

  controls.append(info, remove);
  row.append(button, controls, details);
  return row;
}

async function loadChats() {
  const response = await request("/api/chats");
  chatEntries.replaceChildren(...response.chats.map(renderChatEntry));
}

async function loadRepositories() {
  const response = await request("/api/repositories");
  repositorySelect.replaceChildren(
    new Option("Select a repository", ""),
    ...response.repositories.map((repository) => new Option(repository, repository)),
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
  closeEvents();
  chatView.hidden = true;
  chatList.hidden = false;
  void loadChats();
}

async function openChat(chat) {
  await request(`/api/chats/${encodeURIComponent(chat.id)}/select`, { method: "POST" });
  showChatView();
  chatTitle.textContent = chat.name;
  autoScrollTimeline = true;
  const snapshot = await loadSession();
  scrollTimelineAfterLayout();
  connectEvents(snapshot.events.at(-1)?.id || 0);
}

async function loadSession() {
  const snapshot = await request("/api/session");
  timeline.replaceChildren();
  snapshot.events.forEach(handleEvent);
  setState(snapshot.state);
  autoScrollTimeline = true;
  scrollTimelineAfterLayout();
  return snapshot;
}

function connectEvents(after) {
  closeEvents();
  eventSource = new EventSource(`/api/session/events?after=${after}`);
  const source = eventSource;
  const types = [
    "user.message",
    "assistant.message",
    "assistant.delta",
    "assistant.artifact",
    "session.state",
    "session.error",
    "system.notice",
  ];
  types.forEach((type) => {
    source.addEventListener(type, (message) => {
      handleEvent(JSON.parse(message.data));
    });
  });
  source.onerror = () => {
    errorElement.textContent = "Live updates disconnected; reconnecting…";
  };
  source.onopen = () => {
    errorElement.textContent = "";
  };
}

async function loadResources() {
  try {
    const resources = await request("/api/status/resources");
    document.querySelector("#cpu").textContent = `${resources.cpu.usagePercent}%`;
    document.querySelector("#memory").textContent = `${resources.memory.usagePercent}%`;
    document.querySelector("#disk").textContent = `${resources.disk.usagePercent}%`;
    document.querySelector("#load").textContent = resources.loadAverage[0].toFixed(2);
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
    await request("/api/session/messages", {
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
    await request("/api/session/cancel", { method: "POST" });
  } catch (error) {
    errorElement.textContent = error instanceof Error ? error.message : String(error);
  }
});

backToChats.addEventListener("click", showChatList);
newChatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorElement.textContent = "";
  const repository = repositorySelect.value;
  if (!repository) {
    errorElement.textContent = "Select a repository first";
    return;
  }
  try {
    const response = await request("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository }),
    });
    await openChat(response.chat);
  } catch (error) {
    errorElement.textContent = error instanceof Error ? error.message : String(error);
  }
});
await loadChats();
void loadRepositories().catch((error) => {
  repositorySelect.replaceChildren(new Option("Repositories unavailable", ""));
  errorElement.textContent = error instanceof Error ? error.message : String(error);
});
loadResources();
setInterval(() => void loadResources(), 10_000);
