const stateElement = document.querySelector("#state");
const timeline = document.querySelector("#timeline");
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

assertElement(stateElement, "#state");
assertElement(timeline, "#timeline");
assertElement(composer, "#composer");
assertElement(messageInput, "#message");
assertElement(sendButton, "#send");
assertElement(cancelButton, "#cancel");
assertElement(errorElement, "#error");

function scrollTimelineToBottom() {
  timeline.scrollTop = timeline.scrollHeight;
}

timeline.addEventListener("scroll", () => {
  const distanceFromBottom = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
  autoScrollTimeline = distanceFromBottom <= 32;
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

async function loadSession() {
  const snapshot = await request("/api/session");
  timeline.replaceChildren();
  snapshot.events.forEach(handleEvent);
  setState(snapshot.state);
  return snapshot;
}

function connectEvents(after) {
  const source = new EventSource(`/api/session/events?after=${after}`);
  const types = [
    "user.message",
    "assistant.message",
    "assistant.delta",
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

const initialSnapshot = await loadSession();
connectEvents(initialSnapshot.events.at(-1)?.id || 0);
await loadResources();
setInterval(() => void loadResources(), 10_000);
