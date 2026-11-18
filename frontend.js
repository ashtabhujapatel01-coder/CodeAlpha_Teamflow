"use strict";

const taskList = document.querySelector("#taskList");
const taskModal = document.querySelector("#taskModal");
const taskForm = document.querySelector("#taskForm");
const projectModal = document.querySelector("#projectModal");
const projectForm = document.querySelector("#projectForm");
const workspaceModal = document.querySelector("#workspaceModal");
const joinWorkspaceForm = document.querySelector("#joinWorkspaceForm");
const commentModal = document.querySelector("#commentModal");
const commentForm = document.querySelector("#commentForm");
const commentsContainer = document.querySelector("#commentsContainer");
const commentTaskHeader = document.querySelector("#commentTaskHeader");
const authForm = document.querySelector("#authForm");
const searchInput = document.querySelector("#searchInput");
const tabs = [...document.querySelectorAll(".task-tab")];
let tasks = [];
let projects = [];
let workspaces = [];
let currentUser = null;
let currentFilter = "all";
let currentView = "Overview";
let activeCommentTask = null;
let query = "";
let authMode = "login";
let toastTimeout;

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/auth/login" && path !== "/api/auth/register") {
      showAuth();
    }
    throw new Error(data.error || "The request failed. Please try again.");
  }
  return data;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 2800);
}

function dateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(value) {
  if (!value) return "No due date";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "No due date";
  if (date.toDateString() === new Date().toDateString()) return "Today";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function projectColor(project) {
  return projects.find((item) => item.name === project)?.color || "purple";
}

function showAuth(message = "") {
  document.querySelector("#appShell").hidden = true;
  document.querySelector("#authScreen").hidden = false;
  document.querySelector("#authError").hidden = !message;
  document.querySelector("#authError").textContent = message;
}

function updateAuthMode() {
  const registering = authMode === "register";
  document.querySelector("#authTitle").textContent = registering ? "Create your account" : "Welcome back";
  document.querySelector("#authDescription").textContent = registering
    ? "Start a private workspace for your projects and team."
    : "Sign in to pick up where your team left off.";
  document.querySelector("#authName").hidden = !registering;
  document.querySelector("#authNameLabel").hidden = !registering;
  document.querySelector("#authName").required = registering;
  document.querySelector("#authPassword").autocomplete = registering ? "new-password" : "current-password";
  document.querySelector("#authPassword").placeholder = registering ? "At least 10 characters" : "Your password";
  document.querySelector("#authSubmitButton").innerHTML = registering ? "Create account <span>→</span>" : "Sign in <span>→</span>";
  document.querySelector("#authSwitch").innerHTML = registering
    ? 'Already have an account? <button type="button" id="authSwitchButton">Sign in</button>'
    : 'New to TeamFlow? <button type="button" id="authSwitchButton">Create an account</button>';
}

async function loadWorkspace(user) {
  currentUser = user;
  document.querySelector("#authScreen").hidden = true;
  document.querySelector("#appShell").hidden = false;
  document.querySelector(".workspace-copy strong").textContent = `${user.name}'s workspace`;
  document.querySelector(".workspace-copy span").textContent = "Private workspace";
  document.querySelector(".profile-copy strong").textContent = user.name;
  document.querySelector(".profile-copy small").textContent = user.email;
  const initials = user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  document.querySelectorAll(".avatar-self").forEach((avatar) => {
    avatar.textContent = initials;
    avatar.setAttribute("aria-label", user.name);
  });
  try {
    const [projectData, taskData, workspaceData] = await Promise.all([
      api("/api/projects"),
      api("/api/tasks"),
      api("/api/workspaces")
    ]);
    projects = projectData.projects;
    tasks = taskData.tasks;
    workspaces = workspaceData.workspaces;
    const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceData.active_workspace_id);
    document.querySelector(".workspace-copy strong").textContent = activeWorkspace?.name || `${user.name}'s workspace`;
    document.querySelector(".workspace-copy span").textContent = activeWorkspace
      ? `${activeWorkspace.member_count} ${activeWorkspace.member_count === 1 ? "member" : "members"}`
      : "Private workspace";
    renderWorkspaceOptions(workspaceData.active_workspace_id);
    renderProjects();
    updateTaskProjectOptions();
    selectView("Overview");
  } catch (error) {
    showToast(error.message);
  }
}

function renderWorkspaceOptions(activeWorkspaceId) {
  const select = document.querySelector("#workspaceSelect");
  select.replaceChildren();
  workspaces.forEach((workspace) => {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = `${workspace.name} (${workspace.member_count})`;
    select.append(option);
  });
  select.value = activeWorkspaceId || "";
  document.querySelector("#switchWorkspaceButton").disabled = workspaces.length < 2;
}

function updateTaskProjectOptions() {
  const select = document.querySelector("#taskProject");
  select.replaceChildren();
  projects.forEach((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    select.append(option);
  });
  document.querySelector("#newTaskButton").disabled = projects.length === 0;
  document.querySelector("#inlineNewTask").disabled = projects.length === 0;
}

function renderProjects() {
  const list = document.querySelector("#projectList");
  list.replaceChildren();
  const nav = document.querySelector(".projects-heading");
  let navAnchor = nav;
  document.querySelectorAll(".project-nav").forEach((item) => item.remove());

  projects.forEach((project) => {
    const projectTasks = tasks.filter((task) => task.project_id === project.id);
    const total = projectTasks.length;
    const completed = projectTasks.filter((task) => task.completed).length;
    const progress = total ? Math.round((completed / total) * 100) : 0;
    const card = document.createElement("article");
    card.className = "project-card";
    const top = document.createElement("div");
    top.className = "project-card-top";
    const nameWrap = document.createElement("div");
    nameWrap.className = "project-name-wrap";
    const icon = document.createElement("span");
    icon.className = `project-emoji emoji-${project.color}`;
    icon.textContent = project.color === "orange" ? "◈" : project.color === "green" ? "❋" : "✳";
    const textWrap = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = project.name;
    const meta = document.createElement("span");
    meta.className = "project-meta";
    meta.textContent = `${project.category} · ${total} ${total === 1 ? "task" : "tasks"}`;
    textWrap.append(title, meta);
    nameWrap.append(icon, textWrap);
    const more = document.createElement("button");
    more.className = "more-button";
    more.type = "button";
    more.setAttribute("aria-label", `Delete ${project.name}`);
    more.textContent = "×";
    more.addEventListener("click", async () => {
      if (!window.confirm(`Delete "${project.name}" and all of its tasks? This cannot be undone.`)) return;
      try {
        await api(`/api/projects/${project.id}`, { method: "DELETE" });
        projects = projects.filter((item) => item.id !== project.id);
        tasks = tasks.filter((task) => task.project_id !== project.id);
        renderProjects();
        updateTaskProjectOptions();
        renderTasks();
        showToast("Project deleted");
      } catch (error) {
        showToast(error.message);
      }
    });
    top.append(nameWrap, more);
    const progressLabel = document.createElement("div");
    progressLabel.className = "project-progress-label";
    progressLabel.innerHTML = `<span>Progress</span><strong>${progress}%</strong>`;
    const progressTrack = document.createElement("div");
    progressTrack.className = "progress-track";
    const progressBar = document.createElement("span");
    progressBar.className = `progress-${project.color}`;
    progressBar.style.width = `${progress}%`;
    progressTrack.append(progressBar);
    const bottom = document.createElement("div");
    bottom.className = "project-card-bottom";
    const label = document.createElement("span");
    label.className = "project-meta";
    label.textContent = project.deadline ? `Due ${formatDate(project.deadline)}` : `${completed} completed`;
    bottom.append(label);
    card.append(top, progressLabel, progressTrack, bottom);
    list.append(card);

    const navItem = document.createElement("button");
    navItem.className = "nav-link project-nav";
    navItem.dataset.projectId = project.id;
    const dot = document.createElement("i");
    dot.className = `project-dot dot-${project.color}`;
    navItem.append(dot, document.createTextNode(project.name));
    navItem.addEventListener("click", () => selectView(project.name, project.id));
    navAnchor.after(navItem);
    navAnchor = navItem;
  });
}

function renderTasks() {
  const visibleTasks = tasks.filter((task) => {
    if (currentFilter !== "all" && task.status !== currentFilter) return false;
    if (currentView !== "Overview" && currentView !== "My tasks" && currentView !== "Projects" && currentView !== "Calendar") {
      const selectedProject = projects.find((project) => project.name === currentView);
      if (selectedProject && task.project_id !== selectedProject.id) return false;
    }
    return `${task.title} ${task.project} ${task.status}`.toLowerCase().includes(query);
  });
  taskList.replaceChildren();
  if (!visibleTasks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = query ? "No tasks match your search." : "Nothing here just yet. Add a task to get started.";
    taskList.append(empty);
  }

  visibleTasks.forEach((task) => {
    const row = document.createElement("article");
    row.className = "task-row";
    const check = document.createElement("button");
    check.className = `task-check${task.completed ? " done" : ""}`;
    check.type = "button";
    check.setAttribute("aria-label", task.completed ? `Mark ${task.title} incomplete` : `Complete ${task.title}`);
    check.setAttribute("aria-pressed", String(task.completed));
    check.textContent = task.completed ? "✓" : "";
    check.addEventListener("click", async () => {
      try {
        const result = await api(`/api/tasks/${task.id}`, {
          method: "PATCH",
          body: { completed: !task.completed }
        });
        tasks = tasks.map((item) => item.id === task.id ? result.task : item);
        renderProjects();
        renderTasks();
      } catch (error) {
        showToast(error.message);
      }
    });
    const content = document.createElement("div");
    const title = document.createElement("p");
    title.className = `task-title${task.completed ? " is-complete" : ""}`;
    title.textContent = task.title;
    const meta = document.createElement("div");
    meta.className = "task-meta";
    const dot = document.createElement("i");
    dot.className = `task-project-dot ${projectColor(task.project)}`;
    const project = document.createElement("span");
    project.textContent = task.project;
    const separator = document.createElement("span");
    separator.className = "task-meta-separator";
    separator.textContent = "·";
    const due = document.createElement("span");
    due.textContent = formatDate(task.due_date);
    meta.append(dot, project, separator, due);
    if (task.assignee_name && task.assignee_name !== "Unassigned") {
      const sep = document.createElement("span");
      sep.className = "task-meta-separator";
      sep.textContent = "·";
      const assignee = document.createElement("span");
      assignee.className = "task-assignee";
      assignee.textContent = `👤 ${task.assignee_name}`;
      meta.append(sep, assignee);
    }
    content.append(title, meta);
    const commentBtn = document.createElement("button");
    commentBtn.className = "task-comment-btn";
    commentBtn.type = "button";
    commentBtn.title = "View comments";
    const count = Number(task.comment_count || 0);
    commentBtn.innerHTML = `💬 <span>${count > 0 ? count : "Add"}</span>`;
    commentBtn.addEventListener("click", () => openCommentModal(task));
    const status = document.createElement("span");
    status.className = `task-status ${task.status === "In progress" ? "status-progress" : "status-todo"}`;
    status.textContent = task.completed ? "Done" : task.status;
    const remove = document.createElement("button");
    remove.className = "task-delete icon-button";
    remove.type = "button";
    remove.setAttribute("aria-label", `Delete ${task.title}`);
    remove.textContent = "×";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete "${task.title}"?`)) return;
      try {
        await api(`/api/tasks/${task.id}`, { method: "DELETE" });
        tasks = tasks.filter((item) => item.id !== task.id);
        renderProjects();
        renderTasks();
        showToast("Task deleted");
      } catch (error) {
        showToast(error.message);
      }
    });
    row.append(check, content, commentBtn, status, remove);
    taskList.append(row);
  });

  const activeTasks = tasks.filter((task) => !task.completed);
  const today = dateString(new Date());
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() + (7 - ((weekEnd.getDay() + 6) % 7)) % 7);
  const weekEndString = dateString(weekEnd);
  const dueThisWeek = activeTasks.filter((task) => task.due_date && task.due_date >= today && task.due_date <= weekEndString);
  const dueToday = activeTasks.filter((task) => task.due_date === today).length;
  const completedCount = tasks.filter((task) => task.completed).length;
  document.querySelector("#taskHeadingCount").textContent = visibleTasks.filter((task) => !task.completed).length;
  document.querySelector("#allTabCount").textContent = activeTasks.length;
  document.querySelector("#navTaskCount").textContent = activeTasks.length;
  document.querySelector("#progressCount").textContent = activeTasks.filter((task) => task.status === "In progress").length;
  document.querySelector("#completedCount").textContent = completedCount;
  document.querySelector("#productivityRate").firstChild.textContent = `${tasks.length ? Math.round(completedCount / tasks.length * 100) : 0}`;
  document.querySelector("#dueCount").textContent = dueThisWeek.length;
  document.querySelector("#statDueTodayCount").textContent = dueToday;
  document.querySelector("#todayDueCount").textContent = dueToday;
  document.querySelector(".eyebrow").lastChild.textContent = ` ${new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  }).toUpperCase()}`;
  renderActivity();
  renderCalendar();
}

function renderActivity() {
  const list = document.querySelector("#activityList");
  list.replaceChildren();
  const recentTasks = [...tasks].sort((left, right) => {
    const leftDate = left.updated_at || left.created_at || "";
    const rightDate = right.updated_at || right.created_at || "";
    return rightDate.localeCompare(leftDate);
  }).slice(0, 3);
  if (!recentTasks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Your recent tasks will show up here.";
    list.append(empty);
    return;
  }
  recentTasks.forEach((task) => {
    const item = document.createElement("div");
    item.className = "activity-item";
    const avatar = document.createElement("span");
    avatar.className = "avatar avatar-lilac";
    avatar.textContent = document.querySelector(".profile-copy strong").textContent.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    const copy = document.createElement("p");
    const title = document.createElement("strong");
    title.textContent = task.title;
    const detail = document.createElement("small");
    detail.textContent = `In ${task.project} · ${task.completed ? "Completed" : task.status}`;
    copy.append(title, detail);
    const badge = document.createElement("span");
    badge.className = task.completed ? "activity-check" : "activity-comment";
    badge.textContent = task.completed ? "✓" : "◷";
    item.append(avatar, copy, badge);
    list.append(item);
  });
}

function renderCalendar() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const weekDays = [...document.querySelectorAll(".week-days > div")];
  weekDays.forEach((element, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    element.querySelector("b").textContent = date.getDate();
    element.querySelector("b").classList.toggle("today", date.getTime() === today.getTime());
    const hasTasks = tasks.some((task) => !task.completed && task.due_date === dateString(date));
    element.querySelector("i").style.visibility = hasTasks ? "visible" : "hidden";
  });
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const format = (date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  document.querySelector("#weekRange").textContent = `${format(monday)} – ${format(sunday)}, ${sunday.getFullYear()}`;
}

function openModal(modal, focusSelector) {
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  window.setTimeout(() => document.querySelector(focusSelector).focus(), 0);
}

function closeModal(modal, form) {
  modal.hidden = true;
  document.body.style.overflow = "";
  form.reset();
}

function selectView(view, projectId = "") {
  currentView = view;
  document.querySelector("#breadcrumbCurrent").textContent = view;
  document.querySelector("#pageTitle").textContent = view === "Overview" ? `Good morning, ${document.querySelector(".profile-copy strong").textContent}` : view;
  document.querySelector("#pageSubtitle").textContent = view === "Overview"
    ? "Here's what's happening with your projects today."
    : `A clear view of what's happening in ${view.toLowerCase()}.`;
  document.querySelectorAll(".nav-link[data-view]").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === view);
  });
  document.querySelectorAll(".project-nav").forEach((link) => {
    link.classList.toggle("active", link.dataset.projectId === projectId);
  });
  document.querySelector("#sidebar").classList.remove("open");
  renderTasks();
}

document.querySelector("#authSwitch").addEventListener("click", (event) => {
  if (event.target.closest("#authSwitchButton")) {
    authMode = authMode === "login" ? "register" : "login";
    document.querySelector("#authError").hidden = true;
    updateAuthMode();
  }
});
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#authSubmitButton");
  button.disabled = true;
  document.querySelector("#authError").hidden = true;
  const form = new FormData(authForm);
  const body = {
    email: String(form.get("email")).trim(),
    password: String(form.get("password"))
  };
  if (authMode === "register") body.name = String(form.get("name")).trim();
  try {
    const result = await api(`/api/auth/${authMode}`, { method: "POST", body });
    authForm.reset();
    await loadWorkspace(result.user);
  } catch (error) {
    document.querySelector("#authError").textContent = error.message;
    document.querySelector("#authError").hidden = false;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    showAuth();
    authMode = "login";
    updateAuthMode();
    document.querySelector("#authForm").reset();
    currentUser = null;
    showToast("Signed out");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#newTaskButton").addEventListener("click", () => openModal(taskModal, "#taskTitle"));
document.querySelector("#inlineNewTask").addEventListener("click", () => openModal(taskModal, "#taskTitle"));
document.querySelector("#closeModalButton").addEventListener("click", () => closeModal(taskModal, taskForm));
document.querySelector("#cancelModalButton").addEventListener("click", () => closeModal(taskModal, taskForm));
taskModal.addEventListener("click", (event) => {
  if (event.target === taskModal) closeModal(taskModal, taskForm);
});
taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(taskForm);
  const title = String(form.get("title") || "").trim();
  if (!title) return document.querySelector("#taskTitle").focus();
  const button = taskForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const result = await api("/api/tasks", {
      method: "POST",
      body: {
        title,
        project_id: String(form.get("project")),
        due_date: String(form.get("due")) || null,
        status: String(form.get("status")),
        assignee_name: String(form.get("assignee") || "").trim() || "Unassigned"
      }
    });
    tasks.unshift(result.task);
    currentFilter = "all";
    query = "";
    searchInput.value = "";
    tabs.forEach((tab) => {
      const selected = tab.dataset.filter === "all";
      tab.classList.toggle("selected", selected);
      tab.setAttribute("aria-selected", String(selected));
    });
    closeModal(taskModal, taskForm);
    renderProjects();
    renderTasks();
    showToast("Your task is on the list");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

tabs.forEach((tab) => tab.addEventListener("click", () => {
  currentFilter = tab.dataset.filter;
  tabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-selected", String(selected));
  });
  renderTasks();
}));
searchInput.addEventListener("input", () => {
  query = searchInput.value.trim().toLowerCase();
  renderTasks();
});

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => selectView(button.dataset.view)));
document.querySelector("#menuButton").addEventListener("click", () => document.querySelector("#sidebar").classList.toggle("open"));
document.querySelector("#addProjectButton").addEventListener("click", () => openModal(projectModal, "#projectName"));
document.querySelector("#closeProjectModalButton").addEventListener("click", () => closeModal(projectModal, projectForm));
document.querySelector("#cancelProjectModalButton").addEventListener("click", () => closeModal(projectModal, projectForm));
projectModal.addEventListener("click", (event) => {
  if (event.target === projectModal) closeModal(projectModal, projectForm);
});
projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(projectForm);
  const button = projectForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const result = await api("/api/projects", {
      method: "POST",
      body: {
        name: String(form.get("name")).trim(),
        category: String(form.get("category")).trim() || "General",
        deadline: String(form.get("deadline")) || null,
        color: String(form.get("color"))
      }
    });
    projects.push(result.project);
    renderProjects();
    updateTaskProjectOptions();
    closeModal(projectModal, projectForm);
    showToast("Project created");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#openWorkspaceModal").addEventListener("click", () => {
  document.querySelector("#inviteCodePanel").hidden = true;
  joinWorkspaceForm.reset();
  openModal(workspaceModal, "#workspaceSelect");
});
document.querySelector("#closeWorkspaceModalButton").addEventListener("click", () => closeModal(workspaceModal, joinWorkspaceForm));
workspaceModal.addEventListener("click", (event) => {
  if (event.target === workspaceModal) closeModal(workspaceModal, joinWorkspaceForm);
});
document.querySelector("#switchWorkspaceButton").addEventListener("click", async () => {
  try {
    await api("/api/workspaces/active", {
      method: "PATCH",
      body: { workspace_id: document.querySelector("#workspaceSelect").value }
    });
    closeModal(workspaceModal, joinWorkspaceForm);
    await loadWorkspace(currentUser);
    showToast("Workspace switched");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#createInviteButton").addEventListener("click", async () => {
  try {
    const result = await api("/api/workspaces/invitations", { method: "POST", body: {} });
    document.querySelector("#inviteCodeOutput").value = result.code;
    document.querySelector("#inviteCodePanel").hidden = false;
    showToast("Invite code created");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#copyInviteButton").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#inviteCodeOutput").value);
    showToast("Invite code copied");
  } catch (error) {
    console.error("Unable to copy workspace invitation.", error);
    showToast("Copy isn't available here. Select and copy the code.");
  }
});
joinWorkspaceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = String(new FormData(joinWorkspaceForm).get("code") || "").trim();
  try {
    await api("/api/workspaces/join", { method: "POST", body: { code } });
    closeModal(workspaceModal, joinWorkspaceForm);
    await loadWorkspace(currentUser);
    showToast("You joined the workspace");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#upgradeButton").addEventListener("click", () => showToast("TeamFlow Pro is coming soon"));
document.querySelector("#notificationButton").addEventListener("click", () => showToast("You're all caught up!"));
document.querySelector("#taskFilterButton").addEventListener("click", () => showToast("Showing tasks for this week"));
async function openCommentModal(task) {
  activeCommentTask = task;
  commentTaskHeader.innerHTML = `<strong>${task.title}</strong><span>${task.project} · ${task.assignee_name || "Unassigned"}</span>`;
  commentsContainer.innerHTML = `<p class="empty-state">Loading comments...</p>`;
  openModal(commentModal, "#commentText");
  try {
    const data = await api(`/api/tasks/${task.id}/comments`);
    renderComments(data.comments || []);
  } catch (error) {
    commentsContainer.innerHTML = `<p class="empty-state">Failed to load comments: ${error.message}</p>`;
  }
}

function renderComments(comments) {
  commentsContainer.replaceChildren();
  if (!comments.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No comments yet. Start the conversation!";
    commentsContainer.append(empty);
    return;
  }
  comments.forEach((c) => {
    const item = document.createElement("div");
    item.className = "comment-item";
    const header = document.createElement("div");
    header.className = "comment-author-row";
    const name = document.createElement("strong");
    name.textContent = c.author_name;
    const time = document.createElement("span");
    time.className = "comment-time";
    time.textContent = new Date(c.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    header.append(name, time);
    const body = document.createElement("p");
    body.className = "comment-body";
    body.textContent = c.content;
    item.append(header, body);
    commentsContainer.append(item);
  });
  commentsContainer.scrollTop = commentsContainer.scrollHeight;
}

document.querySelector("#closeCommentModalButton")?.addEventListener("click", () => closeModal(commentModal, commentForm));
commentModal?.addEventListener("click", (event) => {
  if (event.target === commentModal) closeModal(commentModal, commentForm);
});

commentForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeCommentTask) return;
  const input = document.querySelector("#commentText");
  const content = input.value.trim();
  if (!content) return;
  const button = commentForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/tasks/${activeCommentTask.id}/comments`, {
      method: "POST",
      body: { content }
    });
    input.value = "";
    activeCommentTask.comment_count = (Number(activeCommentTask.comment_count) || 0) + 1;
    tasks = tasks.map((t) => t.id === activeCommentTask.id ? { ...t, comment_count: activeCommentTask.comment_count } : t);
    renderTasks();
    const data = await api(`/api/tasks/${activeCommentTask.id}/comments`);
    renderComments(data.comments || []);
    showToast("Comment posted");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!taskModal.hidden) closeModal(taskModal, taskForm);
    if (!projectModal.hidden) closeModal(projectModal, projectForm);
    if (!workspaceModal.hidden) closeModal(workspaceModal, joinWorkspaceForm);
    if (!commentModal.hidden) closeModal(commentModal, commentForm);
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
});

async function initialize() {
  updateAuthMode();
  try {
    const result = await api("/api/auth/me");
    if (!result.user) {
      showAuth();
      return;
    }
    await loadWorkspace(result.user);
  } catch (error) {
    showAuth(error.message === "Sign in to continue." ? "" : error.message);
  }
}

initialize();
