(() => {
  const api = window.storyClaw;
  const root = document.getElementById("storyclaw-gui-concept");
  if (!api || !root) return;

  const state = {
    projects: [],
    selectedProject: null,
    pendingInput: null,
    renderMode: "",
    running: null,
    previewItems: [],
    previewIndex: -1,
    selectedEpisode: 1,
    previewLoadId: 0,
    showingFinalFilm: false,
    lastLog: "就绪",
    runPhase: "idle",
    runPhaseLabel: "",
    runPhaseDetail: "",
    runStepIndex: 0,
    renderWorkspaceActivated: false,
    agentMonitorActivated: false,
    agentCollapsed: false,
    agentMessages: [],
    agentStreaming: false,
    agentActivityLabel: "",
    agentActivityDetail: "",
    conversationPersistTimer: null,
    conversationPersistPromise: Promise.resolve(),
    projectOpenId: 0,
    pendingChoices: [],
    progressCards: [],
    visualPresetCards: [],
    activeProgressCardId: "",
    homeSourceText: "",
    settings: null,
    settingsDraft: {
      templateName: "",
      templateEnabled: false,
    },
  };

  const style = document.createElement("style");
  style.textContent = `
    html, body { width: 100%; height: 100%; min-width: 0; min-height: 0; margin: 0; overflow: hidden !important; background: #090a0c; }
    #storyclaw-gui-concept { width: 100%; height: 100vh; min-height: 0; overflow: hidden !important; border: 0 !important; border-radius: 0 !important; }
    #storyclaw-gui-concept .sc-shell { display: none !important; }
    #storyclaw-gui-concept .claw-app,
    #storyclaw-gui-concept .claw-library { width: 100%; height: 100%; min-height: 0; overflow: hidden; }
    #storyclaw-gui-concept .claw-library-view { width: 100%; height: 100%; min-height: 0; overflow: hidden; }
    #storyclaw-gui-concept .claw-library-view:not(.claw-home-view) { overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; }
    #storyclaw-gui-concept .claw-library-view::-webkit-scrollbar { width: 10px; }
    #storyclaw-gui-concept .claw-library-view::-webkit-scrollbar-track { background: #111213; }
    #storyclaw-gui-concept .claw-library-view::-webkit-scrollbar-thumb { border: 2px solid #111213; border-radius: 999px; background: #4a4c50; }
    #storyclaw-gui-concept .claw-library-view::-webkit-scrollbar-thumb:hover { background: #6a6d72; }
    #storyclaw-gui-concept .claw-editor { width: 100%; height: 100%; min-height: 0; overflow-x: hidden; overflow-y: auto; }
    #storyclaw-gui-concept .desktop-empty { grid-column: 1 / -1; padding: 42px 16px; border: 1px dashed var(--claw-line); border-radius: 9px; color: var(--claw-muted); text-align: center; }
    #storyclaw-gui-concept .desktop-project-cover-fallback { display: grid; place-items: center; background: linear-gradient(135deg, #35110a, #9e2d16 52%, #f6a528); color: rgba(255,255,255,.82); font-size: 30px; }
    #storyclaw-gui-concept .desktop-project-option-empty { padding: 14px 10px; color: var(--claw-dim); font-size: 12px; }

    /* Keep the library views fixed to the window and move long content into its own pane. */
    #storyclaw-gui-concept .claw-floating-nav {
      top: 50%;
      transform: translateY(-50%);
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] {
      padding-top: 64px;
      overflow: hidden;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-page-title { margin-bottom: 44px; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
      min-height: 0;
      max-height: calc(100% - 62px);
      overflow-x: hidden;
      overflow-y: auto;
      padding-right: 8px;
      scrollbar-gutter: stable;
      scrollbar-color: #45474b transparent;
      scrollbar-width: thin;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-grid::-webkit-scrollbar { width: 7px; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-grid::-webkit-scrollbar-track { background: transparent; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-grid::-webkit-scrollbar-thumb { border-radius: 7px; background: #45474b; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-tile,
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-tile {
      min-height: 250px;
      border-radius: 12px;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-tile {
      display: grid;
      align-items: stretch;
      justify-items: stretch;
      padding: 0;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-center {
      display: grid;
      width: 100%;
      height: 100%;
      grid-template-rows: 140px minmax(0, 1fr);
      gap: 0;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-symbol {
      align-self: center;
      justify-self: center;
      width: 68px;
      height: 56px;
      border-radius: 12px;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-symbol svg { width: 28px; height: 28px; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-cta {
      display: grid;
      width: 100%;
      min-width: 0;
      min-height: 0;
      align-items: center;
      justify-items: center;
      padding: 12px;
      border-top: 1px solid var(--claw-line);
      border-radius: 0 0 12px 12px;
      background: #292a2d;
      color: var(--claw-text);
      font-size: 16px;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-tile {
      grid-template-rows: 140px 1fr;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-cover {
      height: 140px;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-info {
      gap: 7px;
      padding: 12px;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-name { font-size: 15px; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-name {
      overflow: visible;
      display: -webkit-box;
      min-height: 40px;
      line-height: 1.35;
      text-overflow: clip;
      white-space: normal;
      overflow-wrap: anywhere;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-date { font-size: 12px; }

    #storyclaw-gui-concept .claw-assets-view {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 16px;
      padding-top: 76px;
      overflow: hidden !important;
      overflow-y: hidden !important;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-assets-head { margin-bottom: 0; }
    #storyclaw-gui-concept .claw-assets-view .claw-asset-layout {
      min-height: 0;
      height: 100%;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-project-index {
      min-height: 0;
      overflow: hidden;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-project-filter {
      height: 100%;
      max-height: none;
      min-height: 0;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-asset-browser {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-height: 0;
      overflow: hidden;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-grid {
      min-height: 0;
      grid-auto-rows: max-content;
      align-content: start;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-right: 8px;
      scrollbar-gutter: stable;
      scrollbar-color: #45474b transparent;
      scrollbar-width: thin;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-grid::-webkit-scrollbar { width: 7px; }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-grid::-webkit-scrollbar-track { background: transparent; }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-grid::-webkit-scrollbar-thumb { border-radius: 7px; background: #45474b; }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-card {
      display: grid;
      min-height: 0;
      align-self: start;
      grid-template-rows: auto minmax(58px, auto);
    }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-card img {
      width: 100%;
      height: auto;
      min-height: 0;
      aspect-ratio: 16 / 9;
      object-fit: contain;
      background: #26272a;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-meta {
      min-height: 58px;
      padding: 10px 12px;
    }
    #storyclaw-gui-concept .claw-mg-style-card,
    #storyclaw-gui-concept .claw-mg-usage-card {
      position: relative;
      overflow: hidden;
      border: 1px solid #35373b;
      border-radius: 7px;
      background: #1b1c1f;
    }
    #storyclaw-gui-concept .claw-mg-style-card { cursor: default; }
    #storyclaw-gui-concept .claw-mg-preview {
      position: relative;
      display: grid;
      place-items: center;
      width: 100%;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      background: #eef0eb;
      color: #22292c;
    }
    #storyclaw-gui-concept .claw-mg-preview img,
    #storyclaw-gui-concept .claw-mg-preview video { display: block; width: 100%; height: 100%; object-fit: cover; }
    #storyclaw-gui-concept .claw-mg-card-meta { display: grid; gap: 5px; padding: 11px 12px 12px; }
    #storyclaw-gui-concept .claw-mg-card-meta strong { font-size: 14px; }
    #storyclaw-gui-concept .claw-mg-card-meta span { color: var(--claw-muted); font-size: 12px; }
    #storyclaw-gui-concept .claw-mg-card-badge,
    #storyclaw-gui-concept .claw-mg-order-badge { position: absolute; z-index: 2; top: 8px; right: 8px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 4px; background: rgba(14,15,17,.82); color: #f1c94b; font-size: 11px; line-height: 22px; text-align: center; }
    #storyclaw-gui-concept .claw-mg-usage-card { display: grid; gap: 12px; min-width: 0; padding: 15px; }
    #storyclaw-gui-concept .claw-mg-usage-head { display: grid; gap: 4px; min-width: 0; padding-right: 34px; }
    #storyclaw-gui-concept .claw-mg-usage-head strong,
    #storyclaw-gui-concept .claw-mg-usage-head span { min-width: 0; overflow-wrap: anywhere; }
    #storyclaw-gui-concept .claw-mg-usage-head span { color: var(--claw-muted); font-size: 12px; line-height: 1.45; }
    #storyclaw-gui-concept .claw-mg-style-control { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0; }
    #storyclaw-gui-concept .claw-mg-style-control select { width: 100%; min-width: 0; height: 36px; border: 1px solid #414349; border-radius: 5px; padding: 0 9px; background: #25272a; color: var(--claw-text); }
    #storyclaw-gui-concept .claw-mg-replace { display: inline-flex; align-items: center; gap: 6px; width: 100%; min-width: 88px; height: 36px; justify-content: center; padding: 0 8px; border: 1px solid #735f24; border-radius: 5px; background: #3a3117; color: #f1c94b; white-space: nowrap; }
    #storyclaw-gui-concept .claw-mg-replace:disabled { cursor: not-allowed; opacity: .42; }
    #storyclaw-gui-concept .claw-mg-lock-note { color: #aaadb3; font-size: 12px; }
    #storyclaw-gui-concept .claw-editor {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) 140px;
      overflow: hidden !important;
    }
    #storyclaw-gui-concept .claw-editor-upper {
      height: auto;
      min-height: 0;
      overflow: hidden;
    }
    #storyclaw-gui-concept .claw-editor-upper > .claw-script-panel,
    #storyclaw-gui-concept .claw-editor-upper > .claw-preview-stage {
      min-height: 0;
    }
    #storyclaw-gui-concept .claw-editor-upper > .claw-script-panel {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    #storyclaw-gui-concept .claw-editor-upper .claw-script-list {
      height: auto;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-color: #45474b transparent;
      scrollbar-width: thin;
    }
    #storyclaw-gui-concept .claw-editor-upper .claw-script-list::-webkit-scrollbar { width: 7px; }
    #storyclaw-gui-concept .claw-editor-upper .claw-script-list::-webkit-scrollbar-track { background: transparent; }
    #storyclaw-gui-concept .claw-editor-upper .claw-script-list::-webkit-scrollbar-thumb { border-radius: 7px; background: #45474b; }
    #storyclaw-gui-concept .claw-editor-upper .claw-script-fade { display: none; }
    #storyclaw-gui-concept .claw-script-card { padding: 10px 12px 11px; }
    #storyclaw-gui-concept .claw-script-labels { gap: 10px; margin-bottom: 10px; }
    #storyclaw-gui-concept .claw-script-card p { margin: 0 0 10px; font-size: 14px; line-height: 1.55; }
    #storyclaw-gui-concept .claw-script-card p:last-child { margin-bottom: 0; }
    #storyclaw-gui-concept .claw-timeline {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 8px;
      height: auto;
      min-height: 0;
      overflow: hidden;
      padding-bottom: 0;
    }
    #storyclaw-gui-concept .claw-scrubber { margin-bottom: 0; }
    #storyclaw-gui-concept .claw-shot-strip {
      display: flex;
      min-height: 0;
      align-items: flex-end;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior-x: contain;
      padding-bottom: 0;
      scrollbar-color: #45474b transparent;
      scrollbar-width: thin;
    }
    #storyclaw-gui-concept .claw-shot-strip::-webkit-scrollbar { height: 8px; }
    #storyclaw-gui-concept .claw-shot-strip::-webkit-scrollbar-track { background: transparent; }
    #storyclaw-gui-concept .claw-shot-strip::-webkit-scrollbar-thumb { border-radius: 8px; background: #45474b; }
    #storyclaw-gui-concept .claw-shot-placeholder {
      display: grid;
      width: 100%;
      aspect-ratio: 16 / 9;
      place-items: center;
      align-content: center;
      gap: 6px;
      background: #17181b;
      color: #8f9298;
      font-size: 11px;
    }
    #storyclaw-gui-concept .claw-shot-placeholder svg { width: 20px; height: 20px; }
    #storyclaw-gui-concept .claw-shot.is-pending .claw-shot-caption { color: #b8bac0; text-shadow: none; }
    #storyclaw-gui-concept .claw-timeline-scroll { display: none; }
    #storyclaw-gui-concept .claw-preview-image {
      width: min(980px, 92%);
      max-width: 100%;
      height: calc(100% - 50px);
      max-height: none;
      object-fit: contain;
    }

    /* The script panel collapses to a narrow rail so the preview keeps its width. */
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-editor-upper {
      grid-template-columns: 52px minmax(0, 1fr);
    }
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-script-head {
      display: flex;
      min-height: 100%;
      align-items: flex-start;
      justify-content: center;
      padding: 18px 6px;
      border-bottom: 0;
    }
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-script-head h2,
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-script-stats,
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-script-list { display: none; }
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-collapse {
      position: static;
      margin: 0;
    }
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-collapse svg { transform: rotate(180deg); }
    #storyclaw-gui-concept .claw-editor.has-agent-panel {
      grid-template-columns: minmax(0, 1fr) minmax(300px, 340px);
      grid-template-rows: auto minmax(0, 1fr) 140px;
    }
    #storyclaw-gui-concept .claw-editor.has-agent-panel .claw-editor-topbar { grid-column: 1 / -1; }
    #storyclaw-gui-concept .claw-editor.has-agent-panel .claw-editor-upper,
    #storyclaw-gui-concept .claw-editor.has-agent-panel .claw-timeline { grid-column: 1; }
    #storyclaw-gui-concept .claw-editor.has-agent-panel .claw-agent-panel {
      grid-column: 2;
      grid-row: 2 / span 2;
    }
    #storyclaw-gui-concept .claw-editor.has-agent-panel.is-agent-collapsed {
      grid-template-columns: minmax(0, 1fr) 44px;
    }
    #storyclaw-gui-concept .claw-agent-panel {
      position: relative;
      display: grid;
      min-width: 0;
      min-height: 0;
      grid-template-rows: minmax(0, 1fr) auto;
      border-left: 1px solid var(--claw-line);
      background: #111213;
      color: var(--claw-text);
    }
    #storyclaw-gui-concept .claw-agent-collapse {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 2;
      display: grid;
      width: 28px;
      height: 28px;
      place-items: center;
    }
    #storyclaw-gui-concept .claw-agent-messages { display: grid; min-height: 0; align-content: start; gap: 10px; overflow-y: auto; padding: 54px 12px 16px; scrollbar-color: #45474b transparent; scrollbar-width: thin; }
    #storyclaw-gui-concept .claw-agent-messages::-webkit-scrollbar { width: 6px; }
    #storyclaw-gui-concept .claw-agent-messages::-webkit-scrollbar-thumb { border-radius: 6px; background: #45474b; }
    #storyclaw-gui-concept .claw-agent-message { max-width: 94%; padding: 8px 10px; border-radius: 7px; color: var(--claw-text); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
    #storyclaw-gui-concept .claw-agent-message[data-role="assistant"] { justify-self: start; background: #1c1d20; }
    #storyclaw-gui-concept .claw-agent-message[data-role="user"] { justify-self: end; background: #3b2418; color: #f4e3d5; }
    #storyclaw-gui-concept .claw-agent-message[data-role="system"] { max-width: 100%; padding: 0; color: var(--claw-muted); background: transparent; font-size: 11px; }
    #storyclaw-gui-concept .claw-agent-composer { display: grid; grid-template-columns: minmax(0, 1fr) 34px; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--claw-line); }
    #storyclaw-gui-concept .claw-agent-composer textarea { width: 100%; min-height: 36px; max-height: 96px; resize: vertical; box-sizing: border-box; padding: 9px 10px; border: 1px solid #35363a; border-radius: 7px; outline: none; background: #191a1d; color: var(--claw-text); font: inherit; font-size: 12px; line-height: 1.4; }
    #storyclaw-gui-concept .claw-agent-composer textarea:focus { border-color: var(--claw-orange); }
    #storyclaw-gui-concept .claw-agent-send { display: grid; width: 34px; height: 34px; place-items: center; align-self: end; border-radius: 50%; background: var(--claw-gradient) !important; color: #271007 !important; box-shadow: 0 6px 16px rgba(255, 91, 25, .2); }
    #storyclaw-gui-concept .claw-editor.has-agent-panel.is-agent-collapsed .claw-agent-panel { display: block; padding: 0; }
    #storyclaw-gui-concept .claw-editor.has-agent-panel.is-agent-collapsed .claw-agent-collapse { top: 12px; right: 12px; margin: 0; }
    #storyclaw-gui-concept .claw-editor.has-agent-panel.is-agent-collapsed .claw-agent-messages,
    #storyclaw-gui-concept .claw-editor.has-agent-panel.is-agent-collapsed .claw-agent-composer { display: none; }
    #storyclaw-gui-concept .claw-compact-control.is-active { border-color: rgba(255, 122, 24, .68); background: #3b2418 !important; color: #ffd8bd !important; }
    #storyclaw-gui-concept .claw-home-view.is-project-chat { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: 18px; padding-top: 86px; padding-bottom: 44px; text-align: left; }
    #storyclaw-gui-concept .claw-home-view.is-project-chat > [data-claw-home-landing] { display: none !important; }
    #storyclaw-gui-concept .claw-project-chat { display: grid; width: min(820px, 100%); min-height: 0; margin: 0 auto; grid-template-rows: minmax(0, 1fr) auto; gap: 14px; }
    #storyclaw-gui-concept .claw-project-chat-messages { display: grid; align-content: start; gap: 10px; min-height: 0; overflow-y: auto; padding: 6px 4px 10px; scrollbar-color: #45474b transparent; scrollbar-width: thin; }
    #storyclaw-gui-concept .claw-project-chat-messages::-webkit-scrollbar { width: 7px; }
    #storyclaw-gui-concept .claw-project-chat-messages::-webkit-scrollbar-thumb { border-radius: 7px; background: #45474b; }
    #storyclaw-gui-concept .claw-project-chat-message { max-width: 78%; padding: 11px 13px; border-radius: 8px; color: var(--claw-text); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
    #storyclaw-gui-concept .claw-project-chat-message[data-role="user"] { justify-self: end; background: #3b2418; color: #f8e2d2; }
    #storyclaw-gui-concept .claw-project-chat-message[data-role="assistant"] { justify-self: start; background: #1d1f22; }
    #storyclaw-gui-concept .claw-project-chat-message[data-role="system"] { max-width: 100%; padding: 2px 0; color: var(--claw-muted); background: transparent; font-size: 12px; }
    #storyclaw-gui-concept .claw-project-chat-composer { display: grid; grid-template-columns: minmax(0, 1fr) 36px; gap: 8px; padding-top: 10px; border-top: 1px solid var(--claw-line); }
    #storyclaw-gui-concept .claw-project-chat-composer textarea { width: 100%; min-height: 42px; max-height: 110px; resize: vertical; padding: 10px 11px; border: 1px solid #3a3c40; border-radius: 8px; outline: none; background: #191a1c; color: var(--claw-text); font: inherit; font-size: 13px; line-height: 1.45; }
    #storyclaw-gui-concept .claw-project-chat-composer textarea:focus { border-color: var(--claw-orange); }
    #storyclaw-gui-concept .claw-project-chat-send { align-self: end; height: 36px; border-radius: 8px; background: var(--claw-orange) !important; color: #1b0b02 !important; }
    #storyclaw-gui-concept .claw-chat-nav {
      position: absolute;
      top: 8px;
      left: 18px;
      z-index: 12;
    }
    #storyclaw-gui-concept .claw-chat-nav[hidden],
    #storyclaw-gui-concept .claw-chat-nav-menu[hidden] { display: none !important; }
    #storyclaw-gui-concept .claw-chat-nav-trigger {
      display: grid;
      height: 44px;
      grid-template-columns: 34px auto 18px;
      align-items: center;
      gap: 9px;
      padding: 0 12px 0 9px;
      border: 1px solid #3d3f43;
      border-radius: 8px;
      background: #202124;
      color: #f2f2f3;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .22);
    }
    #storyclaw-gui-concept .claw-chat-nav-trigger:hover,
    #storyclaw-gui-concept .claw-chat-nav-trigger[aria-expanded="true"] { background: #292a2d; }
    #storyclaw-gui-concept .claw-chat-nav-trigger img { width: 34px; height: 34px; object-fit: contain; }
    #storyclaw-gui-concept .claw-chat-nav-trigger strong { font-size: 15px; letter-spacing: 0; white-space: nowrap; }
    #storyclaw-gui-concept .claw-chat-nav-trigger svg { width: 16px; height: 16px; color: #aeb0b5; transition: transform .16s ease; }
    #storyclaw-gui-concept .claw-chat-nav-trigger[aria-expanded="true"] svg { transform: rotate(180deg); }
    #storyclaw-gui-concept .claw-chat-nav-menu {
      display: grid;
      width: 210px;
      gap: 2px;
      margin-top: 7px;
      padding: 7px;
      border: 1px solid #36383c;
      border-radius: 8px;
      background: #27282b;
      box-shadow: 0 14px 32px rgba(0, 0, 0, .34);
    }
    #storyclaw-gui-concept .claw-chat-nav-menu button {
      min-height: 46px;
      padding: 0 14px;
      border-radius: 6px;
      color: #ededee;
      font-size: 14px;
      font-weight: 600;
      text-align: left;
    }
    #storyclaw-gui-concept .claw-chat-nav-menu button:hover { background: #35363a; }
    /* The home surface is a conversation, not a project dashboard. */
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-brand,
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-floating-nav { display: none !important; }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-view {
      display: grid;
      grid-template-columns: minmax(0, 940px);
      grid-template-rows: minmax(0, 1fr);
      justify-content: center;
      align-items: stretch;
      padding: 0 32px;
      background: #111213;
      text-align: left;
    }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-conversation,
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      width: min(680px, 100%);
      max-width: 680px;
      justify-self: center;
      min-height: 0;
      margin: 0;
      padding: 56px 0 28px;
      gap: 18px;
      text-align: left;
    }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-conversation { grid-template-rows: auto minmax(0, 1fr) auto; }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-messages,
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat-messages {
      display: grid;
      align-content: start;
      gap: 18px;
      min-height: 0;
      overflow-y: auto;
      padding: 10px 24px 20px;
      scrollbar-color: #44464a transparent;
      scrollbar-width: thin;
    }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-messages::-webkit-scrollbar,
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat-messages::-webkit-scrollbar { width: 7px; }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-messages::-webkit-scrollbar-thumb,
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat-messages::-webkit-scrollbar-thumb { border-radius: 7px; background: #44464a; }
    #storyclaw-gui-concept .claw-home-message,
    #storyclaw-gui-concept .claw-project-chat-message {
      max-width: 78%;
      padding: 0;
      border-radius: 0;
      background: transparent !important;
      color: #d8d8da;
      font-size: 15px;
      line-height: 1.75;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #storyclaw-gui-concept .claw-home-message[data-role="user"],
    #storyclaw-gui-concept .claw-project-chat-message[data-role="user"] {
      justify-self: end;
      max-width: min(78%, 580px);
      padding: 12px 15px;
      border-radius: 14px;
      background: #2c2d2f !important;
      color: #eeeeef;
    }
    #storyclaw-gui-concept .claw-home-message[data-role="system"],
    #storyclaw-gui-concept .claw-project-chat-message[data-role="system"] { max-width: 100%; color: #8f9196; font-size: 12px; }
    #storyclaw-gui-concept .claw-home-composer,
    #storyclaw-gui-concept .claw-project-chat-composer {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr) 42px;
      align-items: end;
      gap: 8px;
      margin: 0;
      padding: 0;
      border: 1px solid #3c3e42;
      border-radius: 15px;
      background: #232426;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .22);
    }
    #storyclaw-gui-concept .claw-project-chat-composer { grid-template-columns: minmax(0, 1fr) 42px; }
    #storyclaw-gui-concept .claw-home-composer textarea,
    #storyclaw-gui-concept .claw-project-chat-composer textarea {
      width: 100%;
      min-height: 66px;
      max-height: 180px;
      resize: none;
      box-sizing: border-box;
      padding: 17px 0;
      border: 0;
      outline: none;
      background: transparent;
      color: #e7e7e9;
      font: inherit;
      font-size: 15px;
      line-height: 1.5;
    }
    #storyclaw-gui-concept .claw-project-chat-composer textarea { padding-left: 14px; }
    #storyclaw-gui-concept .claw-home-composer textarea::placeholder,
    #storyclaw-gui-concept .claw-project-chat-composer textarea::placeholder { color: #777a80; }
    #storyclaw-gui-concept .claw-home-composer:focus-within,
    #storyclaw-gui-concept .claw-project-chat-composer:focus-within { border-color: #565960; }
    #storyclaw-gui-concept .claw-home-attach,
    #storyclaw-gui-concept .claw-home-send,
    #storyclaw-gui-concept .claw-project-chat-send {
      display: grid;
      width: 34px;
      height: 34px;
      place-items: center;
      align-self: end;
      margin: 0 0 15px 9px;
      border-radius: 50%;
      background: transparent !important;
      color: #9da0a6 !important;
    }
    #storyclaw-gui-concept .claw-home-send,
    #storyclaw-gui-concept .claw-project-chat-send {
      width: 36px;
      height: 36px;
      margin: 0 10px 14px 0;
      background: linear-gradient(135deg, #ff3f24 0%, #ff7a18 58%, #ffd34a 100%) !important;
      color: #271007 !important;
      box-shadow: 0 7px 18px rgba(255, 91, 25, .2);
    }
    #storyclaw-gui-concept .claw-home-attach:hover,
    #storyclaw-gui-concept .claw-home-send:hover,
    #storyclaw-gui-concept .claw-project-chat-send:hover { color: #f2f2f3 !important; }
    #storyclaw-gui-concept .claw-agent-send[data-run-action="stop"],
    #storyclaw-gui-concept .claw-project-chat-send[data-run-action="stop"] { color: #321108 !important; }
    #storyclaw-gui-concept .claw-agent-send[data-run-action="stop"] svg,
    #storyclaw-gui-concept .claw-project-chat-send[data-run-action="stop"] svg { fill: currentColor; stroke-width: 1.5; }
    #storyclaw-gui-concept .claw-agent-send:disabled,
    #storyclaw-gui-concept .claw-project-chat-send:disabled { cursor: wait; opacity: .62; }
    #storyclaw-gui-concept .claw-pipeline-card {
      display: grid;
      width: min(620px, 88%);
      max-width: 100%;
      justify-self: start;
      gap: 13px;
      padding: 16px 17px 14px;
      border: 1px solid #3e4044;
      border-radius: 12px;
      background: #1c1d20;
      color: #e9e9eb;
    }
    #storyclaw-gui-concept .claw-agent-messages .claw-pipeline-card { width: 100%; padding: 14px 13px 12px; }
    #storyclaw-gui-concept .claw-pipeline-head { display: grid; min-width: 0; grid-template-columns: 10px minmax(0, 1fr); gap: 10px; align-items: start; }
    #storyclaw-gui-concept .claw-pipeline-mark { width: 9px; height: 9px; margin-top: 6px; border-radius: 50%; background: #ff8a25; box-shadow: 0 0 0 5px rgba(255, 122, 24, .1); animation: claw-pipeline-pulse 1.6s ease-in-out infinite; }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="success"] .claw-pipeline-mark { background: #55d6b6; box-shadow: 0 0 0 5px rgba(85, 214, 182, .1); animation: none; }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="warning"] .claw-pipeline-mark { background: #ffd34e; box-shadow: 0 0 0 5px rgba(255, 211, 78, .1); animation: none; }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="error"] .claw-pipeline-mark { background: #ff6a5f; box-shadow: 0 0 0 5px rgba(255, 106, 95, .1); animation: none; }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="paused"] { border-color: #34363a; background: #18191b; }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="paused"] .claw-pipeline-mark { background: #74777d; box-shadow: none; animation: none; }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="paused"] .claw-pipeline-title { color: #b8bac0; }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="paused"] .claw-pipeline-detail,
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="paused"] .claw-pipeline-log,
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="paused"] .claw-pipeline-step { color: #74777d; }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="paused"] .claw-pipeline-track-fill,
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="paused"] .claw-pipeline-step[data-state="done"] .claw-pipeline-step-dot { border-color: #66696f; background: #66696f; box-shadow: none; }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="paused"] .claw-pipeline-step[data-state="current"] .claw-pipeline-step-dot { border-color: #7c7f85; background: #18191b; box-shadow: none; }
    #storyclaw-gui-concept .claw-pipeline-copy { display: grid; min-width: 0; gap: 4px; }
    #storyclaw-gui-concept .claw-pipeline-title { color: #f2f2f3; font-size: 15px; font-weight: 650; line-height: 1.35; }
    #storyclaw-gui-concept .claw-pipeline-detail { color: #aaacb1; font-size: 12px; line-height: 1.5; }
    #storyclaw-gui-concept .claw-pipeline-log { overflow: hidden; color: #7f8288; font-size: 11px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
    #storyclaw-gui-concept .claw-pipeline-rail { position: relative; min-width: 0; padding-top: 1px; }
    #storyclaw-gui-concept .claw-pipeline-track { position: absolute; top: 6px; height: 2px; overflow: hidden; border-radius: 2px; background: #393b40; }
    #storyclaw-gui-concept .claw-pipeline-track-fill { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #ff4a2d, #ff9b27 72%, #ffd34a); transition: width .22s ease; }
    #storyclaw-gui-concept .claw-pipeline-steps { position: relative; display: grid; min-width: 0; }
    #storyclaw-gui-concept .claw-pipeline-step { display: grid; min-width: 0; justify-items: center; gap: 7px; color: #6f7278; font-size: 10px; line-height: 1.2; text-align: center; }
    #storyclaw-gui-concept .claw-pipeline-step-dot { position: relative; z-index: 1; width: 11px; height: 11px; border: 2px solid #55585e; border-radius: 50%; background: #1c1d20; }
    #storyclaw-gui-concept .claw-pipeline-step-label { min-width: 0; overflow-wrap: anywhere; }
    #storyclaw-gui-concept .claw-pipeline-step[data-state="done"],
    #storyclaw-gui-concept .claw-pipeline-step[data-state="current"] { color: #dddde0; }
    #storyclaw-gui-concept .claw-pipeline-step[data-state="done"] .claw-pipeline-step-dot { border-color: #ff9a26; background: #ff9a26; box-shadow: 0 0 0 3px rgba(255, 154, 38, .08); }
    #storyclaw-gui-concept .claw-pipeline-step[data-state="current"] .claw-pipeline-step-dot { border-color: #ffd34a; background: #1c1d20; box-shadow: 0 0 0 4px rgba(255, 154, 38, .12); }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="error"] .claw-pipeline-step[data-state="current"] .claw-pipeline-step-dot { border-color: #ff6a5f; box-shadow: 0 0 0 4px rgba(255, 106, 95, .1); }
    #storyclaw-gui-concept .claw-pipeline-card[data-tone="warning"] .claw-pipeline-step[data-state="current"] .claw-pipeline-step-dot { border-color: #ffd34e; }
    #storyclaw-gui-concept .claw-agent-messages .claw-pipeline-card { gap: 11px; }
    #storyclaw-gui-concept .claw-agent-messages .claw-pipeline-title { font-size: 13px; }
    #storyclaw-gui-concept .claw-agent-messages .claw-pipeline-detail { font-size: 11px; }
    #storyclaw-gui-concept .claw-agent-messages .claw-pipeline-step { font-size: 9px; }
    @keyframes claw-pipeline-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
    #storyclaw-gui-concept .claw-home-capabilities {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
      margin: 0 24px -4px;
      color: #93959a;
      font-size: 11px;
    }
    #storyclaw-gui-concept .claw-home-capabilities span { padding: 5px 9px; border-radius: 7px; background: #292a2c; }
    #storyclaw-gui-concept .claw-home-upload-menu { position: absolute; bottom: 106px; left: 24px; z-index: 3; display: grid; gap: 4px; padding: 6px; border: 1px solid #3c3e42; border-radius: 9px; background: #202124; box-shadow: 0 12px 28px rgba(0,0,0,.3); }
    #storyclaw-gui-concept .claw-home-upload-menu button { padding: 8px 10px; border-radius: 6px; color: #d9dadd; text-align: left; }
    #storyclaw-gui-concept .claw-home-upload-menu button:hover { background: #303135; }
    #storyclaw-gui-concept .claw-choice-card { max-width: min(620px, 88%); padding: 16px 18px; border: 1px solid #3e4044; border-radius: 12px; background: #1c1d20; }
    #storyclaw-gui-concept .claw-choice-title { color: #f0f0f1; font-size: 15px; font-weight: 600; }
    #storyclaw-gui-concept .claw-choice-description { margin-top: 6px; color: #a8aaaf; font-size: 12px; line-height: 1.55; }
    #storyclaw-gui-concept .claw-choice-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-top: 13px; }
    #storyclaw-gui-concept .claw-choice-option { display: grid; gap: 4px; min-height: 52px; padding: 9px 10px; border: 1px solid #45474c; border-radius: 8px; background: #252629; color: #e6e6e8; text-align: left; }
    #storyclaw-gui-concept .claw-choice-option:hover:not(:disabled) { border-color: #8c5ea8; background: #2d2930; }
    #storyclaw-gui-concept .claw-choice-option:disabled { cursor: default; opacity: .55; }
    #storyclaw-gui-concept .claw-choice-option strong { font-size: 12px; font-weight: 600; }
    #storyclaw-gui-concept .claw-choice-option span { color: #9b9da2; font-size: 11px; line-height: 1.35; }
    #storyclaw-gui-concept .claw-choice-card[data-selected="true"] { border-color: #675278; }
    #storyclaw-gui-concept .claw-settings-summary-card { display: grid; width: min(100%, 920px); max-width: 100%; gap: 10px; padding: 13px 15px; border: 1px solid #3d3f44; border-radius: 8px; background: #17181a; }
    #storyclaw-gui-concept .claw-settings-summary-card > strong { color: #e9eaec; font-size: 13px; font-weight: 600; }
    #storyclaw-gui-concept .claw-settings-summary-items { display: flex; flex-wrap: wrap; gap: 6px; }
    #storyclaw-gui-concept .claw-settings-summary-items span { padding: 4px 8px; border: 1px solid #34363a; border-radius: 5px; background: #202124; color: #aeb0b5; font-size: 11px; line-height: 1.35; }
    #storyclaw-gui-concept .claw-home-messages,
    #storyclaw-gui-concept .claw-project-chat-messages,
    #storyclaw-gui-concept .claw-agent-messages { grid-auto-rows: max-content; }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-conversation,
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat {
      width: min(1180px, calc(100vw - 64px));
      max-width: 1180px;
      justify-self: center;
    }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-messages,
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat-messages { width: 100%; }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-composer,
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat-composer {
      width: min(680px, 100%);
      justify-self: center;
    }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-message[data-role="assistant"],
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-message[data-role="system"],
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat-message[data-role="assistant"],
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat-message[data-role="system"],
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-pipeline-card,
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-choice-card,
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-settings-summary-card {
      max-width: 680px;
      margin-left: max(0px, calc(50% - 340px));
    }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-message[data-role="user"],
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat-message[data-role="user"] {
      margin-right: max(0px, calc(50% - 340px));
    }
    #storyclaw-gui-concept .claw-library.is-chat-surface .claw-settings-summary-card { width: min(100%, 680px); }
    #storyclaw-gui-concept .claw-preset-review-card { display: grid; align-self: start; width: 100%; min-width: 0; overflow: hidden; border: 1px solid #3d3f44; border-radius: 8px; background: #191a1d; }
    #storyclaw-gui-concept .claw-preset-review-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 18px 20px 16px; border-bottom: 1px solid #34363a; }
    #storyclaw-gui-concept .claw-preset-review-copy { display: flex; flex: 1 1 auto; align-items: baseline; min-width: 0; }
    #storyclaw-gui-concept .claw-preset-review-copy strong { color: #f0f0f1; font-size: 15px; font-weight: 600; line-height: 1.4; }
    #storyclaw-gui-concept .claw-mg-open { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; padding: 3px 0; border: 0; background: transparent; color: #d5a46a; font-size: 12px; font-weight: 600; line-height: 1.5; }
    #storyclaw-gui-concept .claw-mg-open:hover { color: #f0c18a; }
    #storyclaw-gui-concept .claw-mg-open:disabled { cursor: wait; opacity: .55; }
    #storyclaw-gui-concept .claw-preset-review-card[data-status="superseded"] { border-color: #34363a; background: #151618; opacity: .68; }
    #storyclaw-gui-concept .claw-preset-table-wrap { min-width: 0; overflow: visible; }
    #storyclaw-gui-concept .claw-preset-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 13px; }
    #storyclaw-gui-concept .claw-preset-table th { padding: 11px 16px; border-bottom: 1px solid #3b3d42; background: #222326; color: #cfd0d3; font-size: 12px; font-weight: 600; line-height: 1.4; text-align: left; white-space: normal; overflow-wrap: anywhere; }
    #storyclaw-gui-concept .claw-preset-table td { padding: 14px 16px; border-bottom: 1px solid #303236; color: #c4c6ca; line-height: 1.65; vertical-align: top; white-space: normal; overflow-wrap: anywhere; }
    #storyclaw-gui-concept .claw-preset-table th:first-child,
    #storyclaw-gui-concept .claw-preset-table td:first-child { width: 52px; padding-right: 8px; padding-left: 8px; color: #777a80; text-align: center; }
    #storyclaw-gui-concept .claw-preset-review-card[data-article-type="essay"] .claw-preset-table th:nth-child(2) { width: 42%; }
    #storyclaw-gui-concept .claw-preset-review-card[data-article-type="story"] .claw-preset-table th:nth-child(2) { width: 28%; }
    #storyclaw-gui-concept .claw-preset-table td:nth-child(2) { color: #ededee; }
    #storyclaw-gui-concept .claw-preset-table tbody tr:last-child td { border-bottom: 0; }
    #storyclaw-gui-concept .claw-preset-review-actions { display: flex; justify-content: flex-end; padding: 16px 20px 18px; }
    #storyclaw-gui-concept .claw-preset-approve { min-width: 64px; min-height: 32px; padding: 5px 12px; border-radius: 6px; background: var(--claw-gradient) !important; color: #261006 !important; font-size: 12px; font-weight: 600; }
    #storyclaw-gui-concept .claw-preset-approve:disabled { cursor: default; opacity: .55; }
    @media (max-width: 900px) {
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-conversation,
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat { width: calc(100vw - 28px); }
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-message,
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat-message,
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-pipeline-card,
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-choice-card,
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-settings-summary-card { margin-right: 0; margin-left: 0; }
      #storyclaw-gui-concept .claw-preset-review-head { align-items: flex-start; padding: 15px 14px 13px; }
      #storyclaw-gui-concept .claw-preset-table { font-size: 11px; }
      #storyclaw-gui-concept .claw-preset-table th { padding: 9px 7px; font-size: 10px; }
      #storyclaw-gui-concept .claw-preset-table td { padding: 11px 7px; }
      #storyclaw-gui-concept .claw-preset-table th:first-child,
      #storyclaw-gui-concept .claw-preset-table td:first-child { width: 38px; padding-right: 4px; padding-left: 4px; }
      #storyclaw-gui-concept .claw-preset-review-card[data-article-type="story"] .claw-preset-table th:nth-child(2) { width: 24%; }
      #storyclaw-gui-concept .claw-preset-review-actions { padding: 14px; }
    }
    @media (max-width: 700px) {
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-view { padding: 0 14px; }
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-home-conversation,
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat { padding-top: 28px; }
      #storyclaw-gui-concept .claw-chat-nav { top: 10px; left: 10px; }
      #storyclaw-gui-concept .claw-library.is-chat-surface .claw-project-chat { padding-top: 76px; }
      #storyclaw-gui-concept .claw-home-message,
      #storyclaw-gui-concept .claw-project-chat-message { max-width: 92%; }
    }
    @media (max-width: 1240px) { #storyclaw-gui-concept .claw-editor.has-agent-panel { grid-template-columns: minmax(0, 1fr) 300px; } }
  `;
  // The concept page keeps a second style block near the document end; append
  // runtime overrides after it so the desktop layout remains authoritative.
  document.body.appendChild(style);

  const libraryScreen = root.querySelector('[data-claw-screen="library"]');
  const editorScreen = root.querySelector('[data-claw-screen="editor"]');
  const libraryViews = [...root.querySelectorAll("[data-claw-view]")];
  const toast = root.querySelector("[data-claw-toast]");

  function cleanLine(value) {
    return String(value || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  }

  function reviewPhaseCopy(articleType) {
    return articleType === "essay"
      ? {
        label: "等待审核画面与 MG 标注",
        detail: "画面预设和 MG 标注已生成，请确认或提出修改意见",
        activity: "等待你审核画面与 MG 标注",
      }
      : {
        label: "等待审核画面预设",
        detail: "画面预设已生成，请确认或提出修改意见",
        activity: "等待你审核画面预设",
      };
  }

  function normalizeConversation(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && ["user", "assistant", "system"].includes(item.role))
      .map((item) => ({ role: item.role, text: String(item.text || "").trim() }))
      .filter((item) => item.text);
  }

  function normalizeProgressCards(value) {
    if (!Array.isArray(value)) return [];
    const validStatuses = new Set(["active", "stopping", "paused", "completed", "failed", "review", "approved"]);
    return value
      .filter((item) => item && typeof item === "object" && item.id)
      .map((item) => ({
        id: String(item.id),
        runId: String(item.runId ?? ""),
        projectName: String(item.projectName || ""),
        episode: Math.max(1, Math.trunc(Number(item.episode) || 1)),
        messageIndex: Math.max(0, Math.trunc(Number(item.messageIndex) || 0)),
        createdAt: String(item.createdAt || ""),
        imagesOnly: Boolean(item.imagesOnly),
        status: validStatuses.has(item.status) ? item.status : "paused",
        phase: String(item.phase || "planning"),
        label: String(item.label || ""),
        detail: String(item.detail || ""),
        log: String(item.log || ""),
        currentIndex: Math.max(0, Math.trunc(Number(item.currentIndex) || 0)),
        pauseNoticeAdded: Boolean(item.pauseNoticeAdded),
        settingsOnly: Boolean(item.settingsOnly),
        settingsSummary: item.settingsSummary && typeof item.settingsSummary === "object"
          ? {
            ...(item.settingsSummary.articleType === "essay" || item.settingsSummary.articleType === "story" ? { articleType: item.settingsSummary.articleType } : {}),
            ...(item.settingsSummary.aspectRatio === "16:9" || item.settingsSummary.aspectRatio === "9:16" ? { aspectRatio: item.settingsSummary.aspectRatio } : {}),
            ...(item.settingsSummary.renderMode === "images_only" || item.settingsSummary.renderMode === "full" ? { renderMode: item.settingsSummary.renderMode } : {}),
            ...(typeof item.settingsSummary.ethnicity === "string" ? { ethnicity: item.settingsSummary.ethnicity } : {}),
            ...(typeof item.settingsSummary.reviewVisualPreset === "boolean" ? { reviewVisualPreset: item.settingsSummary.reviewVisualPreset } : {}),
            ...(typeof item.settingsSummary.requireFinalConfirmation === "boolean" ? { requireFinalConfirmation: item.settingsSummary.requireFinalConfirmation } : {}),
          }
          : null,
      }));
  }

  function normalizeVisualPresetCards(value) {
    if (!Array.isArray(value)) return [];
    const validStatuses = new Set(["active", "superseded", "approved"]);
    return value
      .filter((item) => item && typeof item === "object" && item.id && String(item.text || "").trim())
      .map((item) => ({
        id: String(item.id),
        projectName: String(item.projectName || ""),
        episode: Math.max(1, Math.trunc(Number(item.episode) || 1)),
        messageIndex: Math.max(0, Math.trunc(Number(item.messageIndex) || 0)),
        createdAt: String(item.createdAt || ""),
        status: validStatuses.has(item.status) ? item.status : "superseded",
        ...(item.articleType === "essay" || item.articleType === "story" ? { articleType: item.articleType } : {}),
        text: String(item.text || ""),
      }));
  }

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 2400);
  }

  function showLibraryView(page) {
    if (page !== "home" && state.selectedProject) flushConversationPersist();
    if (libraryScreen) libraryScreen.hidden = false;
    if (editorScreen) editorScreen.hidden = true;
    if (page !== "home") {
      libraryScreen?.classList.remove("is-chat-surface");
      closeChatMenu();
      const chatNav = root.querySelector("[data-chat-nav]");
      if (chatNav) chatNav.hidden = true;
    }
    libraryViews.forEach((view) => { view.hidden = view.dataset.clawView !== page; });
    root.querySelectorAll("[data-claw-page]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.clawPage === page));
    });
  }

  function isRenderPhase(phase) {
    return ["gpu_queued", "gpu_ready", "rendering", "merging", "mg_planning", "mg_rendering", "finalizing", "postprocessing", "gpu_stopped", "completed", "failed", "stopped"].includes(phase);
  }

  function projectHasRenderedEpisode(project, episode) {
    const renderedEpisodes = Array.isArray(project?.renderedEpisodes) ? project.renderedEpisodes : [];
    return renderedEpisodes.includes(Number(episode));
  }

  function isRenderWorkspaceReady(project, episode) {
    if (!project) return false;
    const activeSelection = state.running?.selection;
    const activeEpisode = Number(activeSelection?.episode);
    const activeProject = activeSelection?.novelName === project.novelName && activeEpisode === Number(episode);
    return projectHasRenderedEpisode(project, episode)
      || (activeProject && (state.renderWorkspaceActivated || isRenderPhase(state.running?.phase)));
  }

  function showHomeLanding({ reset = false } = {}) {
    const home = root.querySelector('[data-claw-view="home"]');
    if (!home) return;
    if (reset) {
      const keepActiveRun = Boolean(state.running && ["running", "stopping"].includes(state.running.status));
      flushConversationPersist();
      state.selectedProject = null;
      state.agentMessages = [];
      state.pendingChoices = [];
      state.progressCards = [];
      state.visualPresetCards = [];
      state.activeProgressCardId = "";
      state.homeSourceText = "";
      state.agentStreaming = false;
      state.agentActivityLabel = "";
      state.agentActivityDetail = "";
      if (!keepActiveRun) {
        state.runPhase = "idle";
        state.runPhaseLabel = "";
        state.runPhaseDetail = "";
        state.runStepIndex = 0;
        state.renderWorkspaceActivated = false;
        state.agentMonitorActivated = false;
      }
      state.pendingInput = null;
      const input = root.querySelector(".claw-compose-textarea");
      if (input) input.value = "";
      const count = root.querySelector("[data-claw-compose-count]");
      if (count) count.textContent = "0 / 10000";
      const uploadStatus = root.querySelector("[data-claw-upload-status]");
      if (uploadStatus) uploadStatus.hidden = true;
    }
    home.classList.remove("is-project-chat");
    libraryScreen?.classList.remove("is-chat-surface");
    closeChatMenu();
    const chatNav = root.querySelector("[data-chat-nav]");
    if (chatNav) chatNav.hidden = true;
    root.querySelectorAll("[data-claw-home-landing]").forEach((element) => { element.hidden = false; });
    const chat = root.querySelector("[data-claw-project-chat]");
    if (chat) chat.hidden = true;
    showLibraryView("home");
    renderHomeConversation();
  }

  function activeSettingsTemplate() {
    const settings = state.settings;
    const name = settings?.activeTemplate;
    const template = name && settings?.templates?.[name] ? settings.templates[name] : null;
    const enabled = settings?.templateEnabled === true;
    return {
      templateName: name || "",
      templateEnabled: enabled,
      ...(template?.articleType === "essay" || template?.articleType === "story" ? { articleType: template.articleType } : {}),
      ...(template?.aspectRatio === "16:9" || template?.aspectRatio === "9:16" ? { aspectRatio: template.aspectRatio } : {}),
      ...(template?.renderMode === "images_only" || template?.renderMode === "full" ? { renderMode: template.renderMode } : {}),
      ...(typeof template?.ethnicity === "string" ? { ethnicity: template.ethnicity } : {}),
      ...(typeof template?.reviewVisualPreset === "boolean" ? { reviewVisualPreset: template.reviewVisualPreset } : {}),
      ...(typeof template?.requireFinalConfirmation === "boolean" ? { requireFinalConfirmation: template.requireFinalConfirmation } : {}),
    };
  }

  function settingsForProject(project = state.selectedProject) {
    if (!project || typeof project !== "object") return {};
    // 草稿项目还没有自己的配置；只有这时才把全局模板作为 Agent 上下文。
    if (project.isDraft) {
      const template = activeSettingsTemplate();
      return template.templateEnabled === true ? template : {};
    }
    const summary = project.settingsSummary && typeof project.settingsSummary === "object" ? project.settingsSummary : {};
    const source = { ...summary, ...project };
    return {
      ...(source.articleType === "essay" || source.articleType === "story" ? { articleType: source.articleType } : {}),
      ...(source.aspectRatio === "16:9" || source.aspectRatio === "9:16" ? { aspectRatio: source.aspectRatio } : {}),
      ...(source.renderMode === "images_only" || source.renderMode === "full" ? { renderMode: source.renderMode } : {}),
      ...(typeof source.ethnicity === "string" ? { ethnicity: source.ethnicity } : {}),
      ...(typeof source.reviewVisualPreset === "boolean" ? { reviewVisualPreset: source.reviewVisualPreset } : {}),
      ...(typeof source.requireFinalConfirmation === "boolean" ? { requireFinalConfirmation: source.requireFinalConfirmation } : {}),
    };
  }

  function agentSettingsContext() {
    const settings = activeSettingsTemplate();
    if (settings.templateEnabled !== true) return { templateName: "", templateEnabled: false };
    return settings;
  }

  function populateSettingsTemplateSelect(selectedName) {
    const select = root.querySelector("[data-claw-settings-template-select]");
    if (!select) return;
    const templates = state.settings?.templates && typeof state.settings.templates === "object" ? state.settings.templates : {};
    const names = Object.keys(templates);
    select.replaceChildren(...names.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      return option;
    }));
    if (names.length) select.value = names.includes(selectedName) ? selectedName : (state.settings?.activeTemplate || names[0]);
  }

  function applySettingsForm(settings = activeSettingsTemplate()) {
    const dialog = root.querySelector("[data-claw-settings-dialog]");
    if (!dialog) return;
    const setValue = (selector, value) => { const node = dialog.querySelector(selector); if (node) node.value = value; };
    populateSettingsTemplateSelect(settings.templateName);
    setValue("[data-claw-settings-template-name]", settings.templateName);
    dialog.querySelectorAll("[data-claw-settings-article-type]").forEach((input) => { input.checked = input.value === settings.articleType; });
    dialog.querySelectorAll("[data-claw-settings-aspect-radio]").forEach((input) => { input.checked = input.value === settings.aspectRatio; });
    dialog.querySelectorAll("[data-claw-settings-render-radio]").forEach((input) => { input.checked = input.value === settings.renderMode; });
    const review = dialog.querySelector("[data-claw-settings-review]");
    const final = dialog.querySelector("[data-claw-settings-final]");
    if (review) review.checked = settings.reviewVisualPreset === true;
    if (final) final.checked = settings.requireFinalConfirmation === true;
    const ethnicity = dialog.querySelector("[data-claw-settings-ethnicity]");
    if (ethnicity) ethnicity.value = settings.ethnicity || "";
    const enabled = dialog.querySelector("[data-claw-settings-enabled]");
    if (enabled) enabled.checked = settings.templateEnabled === true;
    state.settingsDraft = { ...settings };
  }

  async function loadSettings() {
    if (typeof api.getSettings !== "function") return;
    try {
      state.settings = await api.getSettings();
      applySettingsForm(activeSettingsTemplate());
    } catch (error) {
      showToast(error instanceof Error ? error.message : "读取制作设置失败");
    }
  }

  function bindSettingsControls() {
    const dialog = root.querySelector("[data-claw-settings-dialog]");
    if (!dialog) return;
    root.querySelectorAll("[data-claw-production-settings-open]").forEach((button) => button.addEventListener("click", () => {
      applySettingsForm(activeSettingsTemplate());
      dialog.showModal?.();
    }));
    root.querySelectorAll("[data-claw-settings-close]").forEach((button) => button.addEventListener("click", () => dialog.close?.()));
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close?.(); });
    dialog.querySelector("[data-claw-settings-template-select]")?.addEventListener("change", async (event) => {
      const name = String(event.currentTarget.value || "");
      const template = state.settings?.templates?.[name];
      if (!template) return;
      try {
        state.settings = typeof api.activateSettingsTemplate === "function"
          ? await api.activateSettingsTemplate(name)
          : { ...state.settings, activeTemplate: name };
        applySettingsForm(activeSettingsTemplate());
      } catch (error) {
        showToast(error instanceof Error ? error.message : "切换模板失败");
      }
    });
    dialog.querySelector("[data-claw-settings-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const aspect = dialog.querySelector("[data-claw-settings-aspect-radio]:checked")?.value;
      const renderMode = dialog.querySelector("[data-claw-settings-render-radio]:checked")?.value;
      const articleType = dialog.querySelector("[data-claw-settings-article-type]:checked")?.value;
      const templateName = dialog.querySelector("[data-claw-settings-template-name]")?.value || "";
      const payload = {
        baseTemplateName: state.settings?.activeTemplate || "",
        templateEnabled: Boolean(dialog.querySelector("[data-claw-settings-enabled]")?.checked),
        templateName,
        settings: {
          ...(articleType === "essay" || articleType === "story" ? { articleType } : {}),
          ...(aspect === "16:9" || aspect === "9:16" ? { aspectRatio: aspect } : {}),
          ...(renderMode === "images_only" || renderMode === "full" ? { renderMode } : {}),
          ...(dialog.querySelector("[data-claw-settings-ethnicity]")?.value ? { ethnicity: dialog.querySelector("[data-claw-settings-ethnicity]").value } : {}),
          reviewVisualPreset: Boolean(dialog.querySelector("[data-claw-settings-review]")?.checked),
          requireFinalConfirmation: Boolean(dialog.querySelector("[data-claw-settings-final]")?.checked),
        },
      };
      try {
        state.settings = await api.saveSettings(payload);
        applySettingsForm(activeSettingsTemplate());
        dialog.close?.();
        showToast(`已保存模板：${state.settings.activeTemplate || "未启用"}`);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "保存制作设置失败");
      }
    });
  }

  function setSystemSettingsTab(tabName) {
    root.querySelectorAll("[data-claw-system-tab]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.clawSystemTab === tabName));
    });
    root.querySelectorAll("[data-claw-system-pane]").forEach((pane) => {
      pane.hidden = pane.dataset.clawSystemPane !== tabName;
    });
  }

  function clearSystemSettingsForm(dialog) {
    dialog.querySelectorAll("[data-system-field], [data-system-json-field]").forEach((input) => {
      if (input.type === "checkbox") input.checked = false;
      else input.value = "";
      input.dataset.systemPresent = "false";
      input.dataset.systemDirty = "false";
      if (input.type === "text" && input.dataset.systemSecret === "true") input.type = "password";
    });
    dialog.querySelectorAll("[data-claw-secret-toggle]").forEach((button) => {
      button.setAttribute("aria-label", "显示密钥");
      button.title = "显示密钥";
      button.innerHTML = '<i data-lucide="eye" aria-hidden="true"></i>';
    });
    const status = dialog.querySelector("[data-claw-system-status]");
    if (status) status.textContent = "";
    window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
  }

  function applySystemSettingsForm(dialog, config) {
    dialog.querySelectorAll("[data-system-field], [data-system-json-field]").forEach((input) => {
      const binding = input.dataset.systemField || input.dataset.systemJsonField || "";
      const [sectionName, fieldName] = binding.split(".");
      const values = config?.sections?.[sectionName]?.values;
      const present = Boolean(values && Object.prototype.hasOwnProperty.call(values, fieldName));
      const value = present ? values[fieldName] : undefined;
      if (input.type === "checkbox") input.checked = value === true;
      else if (input.dataset.systemJsonField) input.value = present ? JSON.stringify(value, null, 2) : "";
      else input.value = present && value !== null && value !== undefined ? String(value) : "";
      input.dataset.systemPresent = String(present);
      input.dataset.systemDirty = "false";
    });
  }

  function collectSystemSettings(dialog) {
    const sections = {};
    dialog.querySelectorAll("[data-system-field], [data-system-json-field]").forEach((input) => {
      if (input.dataset.systemPresent !== "true" && input.dataset.systemDirty !== "true") return;
      const binding = input.dataset.systemField || input.dataset.systemJsonField || "";
      const [sectionName, fieldName] = binding.split(".");
      if (!sectionName || !fieldName) return;
      let value;
      if (input.type === "checkbox") {
        value = Boolean(input.checked);
      } else if (input.dataset.systemJsonField) {
        const raw = String(input.value || "").trim();
        if (!raw) value = null;
        else {
          try {
            value = JSON.parse(raw);
          } catch {
            throw new Error(`${input.closest("label")?.querySelector(":scope > span")?.textContent || fieldName} 不是有效的 JSON`);
          }
        }
      } else if (input.type === "number") {
        value = input.value === "" ? null : Number(input.value);
      } else {
        value = String(input.value || "").trim() || null;
      }
      sections[sectionName] ??= {};
      sections[sectionName][fieldName] = value;
    });
    return { sections };
  }

  function bindSystemSettingsControls() {
    const dialog = root.querySelector("[data-claw-system-settings-dialog]");
    if (!dialog || typeof api.getSystemConfig !== "function") return;
    const status = dialog.querySelector("[data-claw-system-status]");
    const saveButton = dialog.querySelector("[data-claw-system-save]");
    const close = () => dialog.close?.();

    root.querySelectorAll("[data-claw-system-settings-open]").forEach((button) => button.addEventListener("click", async () => {
      clearSystemSettingsForm(dialog);
      setSystemSettingsTab("llm");
      if (status) status.textContent = "正在读取本机配置...";
      if (saveButton) saveButton.disabled = true;
      dialog.showModal?.();
      try {
        const config = await api.getSystemConfig();
        applySystemSettingsForm(dialog, config);
        if (status) status.textContent = "";
        if (saveButton) saveButton.disabled = false;
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : "读取系统设置失败";
      }
    }));

    dialog.querySelectorAll("[data-claw-system-settings-close]").forEach((button) => button.addEventListener("click", close));
    dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
    dialog.addEventListener("close", () => clearSystemSettingsForm(dialog));
    dialog.querySelectorAll("[data-claw-system-tab]").forEach((button) => button.addEventListener("click", () => setSystemSettingsTab(button.dataset.clawSystemTab)));
    dialog.querySelectorAll("[data-system-field], [data-system-json-field]").forEach((input) => {
      const markDirty = () => { input.dataset.systemDirty = "true"; };
      input.addEventListener("input", markDirty);
      input.addEventListener("change", markDirty);
    });
    dialog.querySelectorAll("[data-claw-secret-toggle]").forEach((button) => button.addEventListener("click", () => {
      const input = button.parentElement?.querySelector("input");
      if (!input) return;
      const visible = input.type === "text";
      input.type = visible ? "password" : "text";
      input.dataset.systemSecret = "true";
      button.setAttribute("aria-label", visible ? "显示密钥" : "隐藏密钥");
      button.title = visible ? "显示密钥" : "隐藏密钥";
      button.innerHTML = `<i data-lucide="${visible ? "eye" : "eye-off"}" aria-hidden="true"></i>`;
      window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
    }));
    dialog.querySelectorAll("[data-claw-system-open-directory]").forEach((button) => button.addEventListener("click", async () => {
      try {
        await api.openSystemConfigDirectory(button.dataset.clawSystemOpenDirectory);
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : "打开目录失败";
      }
    }));
    dialog.querySelector("[data-claw-system-settings-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!event.currentTarget.reportValidity()) return;
      if (saveButton) saveButton.disabled = true;
      if (status) status.textContent = "正在保存...";
      try {
        const payload = collectSystemSettings(dialog);
        await api.saveSystemConfig(payload);
        dialog.close?.();
        showToast("系统设置已保存");
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : "保存系统设置失败";
        if (saveButton) saveButton.disabled = false;
      }
    });
  }

  function showConversationSurface(project = null) {
    const home = root.querySelector('[data-claw-view="home"]');
    if (!home) return;
    home.classList.add("is-project-chat");
    root.querySelectorAll("[data-claw-home-landing]").forEach((element) => { element.hidden = true; });
    const chat = root.querySelector("[data-claw-project-chat]");
    if (chat) chat.hidden = false;
    showLibraryView("home");
    libraryScreen?.classList.add("is-chat-surface");
    const chatNav = root.querySelector("[data-chat-nav]");
    if (chatNav) chatNav.hidden = false;
    renderProjectConversation();
    updateProjectChatControls();
    window.requestAnimationFrame(() => root.querySelector("[data-project-chat-input]")?.focus());
  }

  function showProjectChat(project) {
    if (!project) return;
    showConversationSurface(project);
  }

  function closeChatMenu() {
    const trigger = root.querySelector("[data-chat-nav-trigger]");
    const menu = root.querySelector("[data-chat-nav-menu]");
    if (menu) menu.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
  }

  function showEditorSurface() {
    if (libraryScreen) libraryScreen.hidden = true;
    if (editorScreen) editorScreen.hidden = false;
    injectAgentPanel();
    updateAgentPanel();
  }

  function projectTitle(project) {
    return `${project.novelName} · 第 ${project.adaptedCount + 1} 集`;
  }

  function createProjectCard(project) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "claw-project-tile";
    card.dataset.desktopProject = project.id;
    const cover = document.createElement("span");
    cover.className = "claw-project-cover";
    if (project.cover) {
      cover.style.backgroundImage = `url(${project.cover})`;
      cover.style.backgroundSize = "cover";
      cover.style.backgroundPosition = "center";
    } else {
      cover.classList.add("desktop-project-cover-fallback");
      cover.textContent = "SC";
    }
    const info = document.createElement("span");
    info.className = "claw-project-info";
    const name = document.createElement("span");
    name.className = "claw-project-name";
    name.textContent = project.novelName;
    const date = document.createElement("span");
    date.className = "claw-project-date";
    date.textContent = project.episodeCount ? `已完成 ${project.episodeCount} 集 · 下一章 ${project.nextChapter}` : "尚未开始制作";
    info.append(name, date);
    card.append(cover, info);
    card.addEventListener("click", () => openProject(project));
    return card;
  }

  function renderProjects() {
    const grid = root.querySelector(".claw-project-grid");
    if (!grid) return;
    const createTile = grid.querySelector("[data-claw-view-target=home]");
    grid.replaceChildren();
    if (createTile) grid.appendChild(createTile);
    if (!state.projects.length) {
      const empty = document.createElement("div");
      empty.className = "desktop-empty";
      empty.textContent = "还没有项目，从左侧首页创建一个作品";
      grid.appendChild(empty);
      return;
    }
    state.projects.forEach((project) => grid.appendChild(createProjectCard(project)));
  }

  function renderAssetProjectOptions() {
    const filter = root.querySelector(".claw-project-filter");
    if (!filter) return;
    filter.replaceChildren();
    if (!state.projects.length) {
      const empty = document.createElement("div");
      empty.className = "desktop-project-option-empty";
      empty.textContent = "暂无项目";
      filter.appendChild(empty);
      return;
    }
    state.projects.forEach((project, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "claw-project-option";
      button.dataset.desktopAssetProject = project.id;
      button.setAttribute("aria-pressed", String(index === 0));
      const title = document.createElement("strong");
      title.textContent = project.novelName;
      const meta = document.createElement("span");
      meta.textContent = project.articleType === "essay"
        ? "MG 动画素材"
        : `${project.characterCount} 人物 · ${project.sceneCount} 场景`;
      button.append(title, meta);
      button.addEventListener("click", () => renderAssets(project));
      filter.appendChild(button);
    });
  }

  function makeAssetCard(item) {
    const article = document.createElement("article");
    article.className = "claw-reference-card";
    const image = document.createElement("img");
    image.alt = item.name;
    if (item.dataUrl) image.src = item.dataUrl;
    const meta = document.createElement("div");
    meta.className = "claw-reference-meta";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const kind = document.createElement("span");
    kind.textContent = item.kind;
    meta.append(name, kind);
    article.append(image, meta);
    return article;
  }

  function makeMgPreview(item) {
    const preview = item.previewUrl
      ? document.createElement("video")
      : document.createElement("img");
    preview.className = "claw-mg-preview";
    preview.setAttribute("aria-label", item.previewUrl ? `${item.name}动画预览` : "暂无预览视频，请尝试重启");
    if (item.previewUrl) {
      preview.muted = true;
      preview.playsInline = true;
      preview.preload = "metadata";
      preview.src = item.previewUrl;
    } else {
      preview.src = item.previewPlaceholderUrl;
      preview.alt = "暂无预览视频，请尝试重启";
    }
    return preview;
  }

  function makeMgStyleCard(item) {
    const article = document.createElement("article");
    article.className = "claw-mg-style-card";
    article.title = item.description || item.name;
    const badge = document.createElement("span");
    badge.className = "claw-mg-card-badge";
    badge.textContent = item.category;
    const meta = document.createElement("div");
    meta.className = "claw-mg-card-meta";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const detail = document.createElement("span");
    detail.textContent = `${item.structureName} · ${item.renderMode === "overlay" ? "叠加" : "整屏"}`;
    meta.append(name, detail);
    const preview = makeMgPreview(item);
    article.append(preview, badge, meta);
    if (item.previewUrl && preview instanceof HTMLVideoElement) {
      article.addEventListener("mouseenter", () => {
        preview.currentTime = 0;
        preview.play().catch(() => {});
      });
      article.addEventListener("mouseleave", () => {
        preview.pause();
        preview.currentTime = 0;
      });
    }
    return article;
  }

  function makeMgUsageCard(project, usage) {
    const article = document.createElement("article");
    article.className = "claw-mg-usage-card";
    if (Number.isInteger(usage.order)) {
      const badge = document.createElement("span");
      badge.className = "claw-mg-order-badge";
      badge.textContent = String(usage.order);
      badge.title = `${usage.structureName} 的第 ${usage.order} 个动画实例`;
      article.appendChild(badge);
    }
    const head = document.createElement("div");
    head.className = "claw-mg-usage-head";
    const title = document.createElement("strong");
    title.textContent = usage.structureName;
    const meta = document.createElement("span");
    meta.textContent = `${usage.styleName} · ${usage.mode}`;
    head.append(title, meta);
    article.append(head);

    if (!usage.editable) {
      const locked = document.createElement("span");
      locked.className = "claw-mg-lock-note";
      locked.textContent = "联合审核已结束，样式已锁定";
      article.appendChild(locked);
      return article;
    }

    const control = document.createElement("div");
    control.className = "claw-mg-style-control";
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${usage.structureName}样式`);
    (usage.compatibleStyles || []).forEach((styleItem) => {
      const option = document.createElement("option");
      option.value = styleItem.style;
      option.textContent = styleItem.name;
      option.selected = styleItem.style === usage.style;
      select.appendChild(option);
    });
    const replace = document.createElement("button");
    replace.type = "button";
    replace.className = "claw-mg-replace";
    replace.innerHTML = '<i data-lucide="replace" aria-hidden="true"></i><span>替换</span>';
    const updateDisabled = () => {
      replace.disabled = select.value === usage.style || select.options.length < 2;
    };
    select.addEventListener("change", updateDisabled);
    updateDisabled();
    replace.addEventListener("click", async () => {
      const nextStyle = select.value;
      if (!nextStyle || nextStyle === usage.style) return;
      select.disabled = true;
      replace.disabled = true;
      try {
        await api.replaceMgStyle({
          novelName: project.novelName,
          episode: usage.episode,
          tag: usage.tag,
          order: usage.order,
          style: nextStyle,
        });
        showToast(`已将${usage.structureName}替换为${select.options[select.selectedIndex]?.textContent || nextStyle}`);
        await renderAssets(project);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "替换 MG 样式失败");
        select.disabled = false;
        updateDisabled();
      }
    });
    control.append(select, replace);
    article.appendChild(control);
    queueMicrotask(() => window.lucide?.createIcons({ attrs: { width: 15, height: 15 } }));
    return article;
  }

  async function renderAssets(project, requestedMgEpisode = null) {
    if (!project) return;
    root.querySelectorAll("[data-desktop-asset-project]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.desktopAssetProject === project.id));
    });
    const title = root.querySelector("[data-claw-asset-project-title]");
    const meta = root.querySelector("[data-claw-asset-project-meta]");
    const subtitle = root.querySelector("[data-claw-assets-subtitle]");
    const mgEpisodeSelect = root.querySelector("[data-claw-mg-episode-select]");
    const peoplePane = root.querySelector('[data-claw-asset-pane="people"]');
    const scenesPane = root.querySelector('[data-claw-asset-pane="scenes"]');
    const peopleTab = root.querySelector('[data-claw-asset-tab="people"]');
    const scenesTab = root.querySelector('[data-claw-asset-tab="scenes"]');
    if (title) title.textContent = project.novelName;
    try {
      const assets = await api.getAssets(project.novelName);
      if (assets.kind === "mg") {
        if (subtitle) subtitle.textContent = "查看 MG 动画样式，并在画面与 MG 联合审核阶段替换本文实例";
        if (meta) meta.textContent = `${assets.styleCount} 种 MG 样式 · 本文已使用 ${assets.instanceCount} 个实例`;
        if (mgEpisodeSelect) {
          const episodes = [...new Set((assets.episodes || assets.usages || [])
            .map((item) => Number(typeof item === "number" ? item : item.episode))
            .filter((episode) => Number.isInteger(episode) && episode > 0))]
            .sort((left, right) => left - right);
          const previousProject = mgEpisodeSelect.dataset.project || "";
          const requestedEpisode = Number.isInteger(Number(requestedMgEpisode)) && Number(requestedMgEpisode) > 0
            ? Number(requestedMgEpisode)
            : previousProject === project.novelName
              ? Number(mgEpisodeSelect.value)
            : Number.NaN;
          const selectedEpisode = episodes.includes(requestedEpisode) ? requestedEpisode : episodes[0];
          mgEpisodeSelect.replaceChildren(...episodes.map((episode) => {
            const option = document.createElement("option");
            const count = (assets.usages || []).filter((usage) => Number(usage.episode) === episode).length;
            option.value = String(episode);
            option.textContent = `第 ${episode} 集${count ? ` · ${count} 个实例` : ""}`;
            option.selected = episode === selectedEpisode;
            return option;
          }));
          mgEpisodeSelect.hidden = episodes.length === 0;
          mgEpisodeSelect.disabled = episodes.length < 2;
          mgEpisodeSelect.dataset.project = project.novelName;
          mgEpisodeSelect.onchange = () => renderAssets(project, Number(mgEpisodeSelect.value));
        }
        if (peopleTab) peopleTab.textContent = "全部 MG 样式";
        if (scenesTab) scenesTab.textContent = "本文已使用";
        if (peoplePane) {
          peoplePane.replaceChildren();
          (assets.styles || []).forEach((item) => peoplePane.appendChild(makeMgStyleCard(item)));
          if (!assets.styles?.length) peoplePane.innerHTML = '<div class="desktop-empty">暂无可用 MG 样式</div>';
        }
        if (scenesPane) {
          scenesPane.replaceChildren();
          const selectedEpisode = Number(mgEpisodeSelect?.value);
          const usages = Number.isInteger(selectedEpisode) && selectedEpisode > 0
            ? (assets.usages || []).filter((item) => Number(item.episode) === selectedEpisode)
            : (assets.usages || []);
          usages.forEach((item) => scenesPane.appendChild(makeMgUsageCard(project, item)));
          if (!usages.length) {
            scenesPane.innerHTML = assets.usages?.length
              ? '<div class="desktop-empty">本集尚未使用 MG 动画</div>'
              : '<div class="desktop-empty">当前项目尚未生成 MG 标注</div>';
          }
        }
        return;
      }
      if (mgEpisodeSelect) {
        mgEpisodeSelect.hidden = true;
        mgEpisodeSelect.replaceChildren();
        mgEpisodeSelect.onchange = null;
        delete mgEpisodeSelect.dataset.project;
      }
      if (subtitle) subtitle.textContent = "按项目管理人物与场景参考图";
      if (meta) meta.textContent = `${project.characterCount + project.sceneCount} 项资产 · 跨集共享`;
      if (peopleTab) peopleTab.textContent = "人物参考图";
      if (scenesTab) scenesTab.textContent = "场景参考图";
      if (peoplePane) {
        peoplePane.replaceChildren();
        (assets.people || []).forEach((item) => peoplePane.appendChild(makeAssetCard(item)));
        if (!assets.people?.length) peoplePane.innerHTML = '<div class="desktop-empty">暂无人物参考图</div>';
      }
      if (scenesPane) {
        scenesPane.replaceChildren();
        (assets.scenes || []).forEach((item) => scenesPane.appendChild(makeAssetCard(item)));
        if (!assets.scenes?.length) scenesPane.innerHTML = '<div class="desktop-empty">暂无场景参考图</div>';
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "读取资产失败";
      if (meta) meta.textContent = project.articleType === "essay" ? "MG 标注协议错误" : "资产读取失败";
      if (subtitle) {
        subtitle.textContent = project.articleType === "essay"
          ? "当前文件不是新的 MG HTML 协议，请重新生成 MG 标注"
          : "按项目管理人物与场景参考图";
      }
      if (mgEpisodeSelect) {
        mgEpisodeSelect.hidden = true;
        mgEpisodeSelect.replaceChildren();
        mgEpisodeSelect.onchange = null;
        delete mgEpisodeSelect.dataset.project;
      }
      if (peoplePane) {
        peoplePane.replaceChildren();
        const errorCard = document.createElement("div");
        errorCard.className = "desktop-empty";
        errorCard.textContent = project.articleType === "essay"
          ? "当前 MG 标注格式无效，请重新生成"
          : detail;
        peoplePane.appendChild(errorCard);
      }
      if (scenesPane) scenesPane.replaceChildren();
      const peopleTab = root.querySelector('[data-claw-asset-tab="people"]');
      const scenesTab = root.querySelector('[data-claw-asset-tab="scenes"]');
      if (peopleTab) peopleTab.textContent = project.articleType === "essay" ? "全部 MG 样式" : "人物参考图";
      if (scenesTab) scenesTab.textContent = project.articleType === "essay" ? "本文已使用" : "场景参考图";
      showToast(detail);
    }
  }

  function formatPreviewTime(seconds) {
    const value = Number.isFinite(Number(seconds)) ? Math.max(0, Math.round(Number(seconds))) : 0;
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remaining = value % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }

  function availableEpisodes(project) {
    const listed = Array.isArray(project?.episodeNumbers) ? project.episodeNumbers : [];
    const episodes = [...new Set(listed
      .map(Number)
      .filter((episode) => Number.isInteger(episode) && episode > 0))]
      .sort((a, b) => a - b);
    if (episodes.length) return episodes;
    const fallbackCount = Math.max(
      1,
      Math.trunc(Number(project?.latestEpisode) || 0),
      Math.trunc(Number(project?.adaptedCount) || 0),
    );
    return Array.from({ length: fallbackCount }, (_item, index) => index + 1);
  }

  function defaultPreviewEpisode(project) {
    const episodes = availableEpisodes(project);
    const latestCompleted = Math.trunc(Number(project?.adaptedCount) || 0);
    return latestCompleted > 0 && episodes.includes(latestCompleted)
      ? latestCompleted
      : episodes.at(-1) || 1;
  }

  function renderEpisodeOptions(project, selectedEpisode) {
    const projectName = root.querySelector("[data-claw-editor-project-name]");
    const select = root.querySelector("[data-claw-episode-select]");
    if (projectName) projectName.textContent = project?.novelName || "未命名项目";
    if (!select) return;

    const normalizedEpisode = Math.max(1, Math.trunc(Number(selectedEpisode) || 1));
    const episodes = availableEpisodes(project);
    if (!episodes.includes(normalizedEpisode)) episodes.push(normalizedEpisode);
    episodes.sort((a, b) => a - b);
    select.replaceChildren(...episodes.map((episode) => {
      const option = document.createElement("option");
      option.value = String(episode);
      option.textContent = `第 ${episode} 集`;
      return option;
    }));
    select.value = String(normalizedEpisode);
  }

  function setPreviewPlayIcon(playing) {
    const button = root.querySelector("[data-claw-play]");
    if (!button) return;
    button.dataset.playing = String(Boolean(playing));
    button.setAttribute("aria-label", playing ? "暂停" : "播放");
    button.innerHTML = `<i data-lucide="${playing ? "pause" : "play"}" aria-hidden="true"></i>`;
    window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
  }

  function updateFinalFilmButton() {
    const button = root.querySelector("[data-claw-final-film]");
    const regenerate = root.querySelector("[data-claw-regenerate]");
    if (!button) return;
    const showing = state.showingFinalFilm;
    if (regenerate) regenerate.hidden = showing;
    button.setAttribute("aria-pressed", String(showing));
    button.setAttribute("aria-label", showing ? "返回分镜预览" : "展示本集成片");
    button.innerHTML = `<i data-lucide="${showing ? "arrow-left" : "clapperboard"}" aria-hidden="true"></i><span>${showing ? "返回分镜" : "成片展示"}</span>`;
    window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
  }

  function finalFilmUrl(project, episode) {
    const episodeDir = `ep${String(Math.max(1, Math.trunc(Number(episode) || 1))).padStart(2, "0")}`;
    const projectDir = project.id || project.novelName;
    return new URL(
      `../../workspace/${encodeURIComponent(projectDir)}/${episodeDir}/${episodeDir}.mp4`,
      window.location.href,
    ).href;
  }

  function updatePreviewNavigation() {
    const hasItems = state.previewItems.length > 0;
    const previous = root.querySelector("[data-claw-prev]");
    const next = root.querySelector("[data-claw-next]");
    if (state.showingFinalFilm) {
      if (previous) previous.disabled = true;
      if (next) next.disabled = true;
      return;
    }
    if (previous) previous.disabled = !hasItems || state.previewIndex <= 0;
    if (next) next.disabled = !hasItems || state.previewIndex < 0 || state.previewIndex >= state.previewItems.length - 1;
  }

  function setPreviewItem(item, index) {
    const preview = root.querySelector("[data-claw-preview]");
    const range = root.querySelector(".claw-range");
    const current = root.querySelector("[data-claw-current-time]");
    const duration = root.querySelector("[data-claw-duration]");
    const play = root.querySelector("[data-claw-play]");
    const scriptLabel = root.querySelector("[data-claw-script-label]");
    const scriptLead = root.querySelector(".claw-script-labels strong");
    const scriptParagraphs = [...root.querySelectorAll(".claw-script-card p")];
    if (!preview || !item) return;
    state.showingFinalFilm = false;
    state.previewIndex = index;
    updateFinalFilmButton();
    root.querySelectorAll(".claw-shot-strip .claw-shot").forEach((shot, shotIndex) => {
      shot.setAttribute("aria-pressed", String(shotIndex === index));
    });
    if (scriptLabel) scriptLabel.textContent = `分镜${String(index + 1).padStart(2, "0")}`;
    if (scriptLead) scriptLead.textContent = "";
    scriptParagraphs.forEach((paragraph, paragraphIndex) => {
      paragraph.textContent = paragraphIndex === 0 ? item.scriptText || "" : "";
      paragraph.hidden = paragraphIndex !== 0;
    });
    preview.pause?.();
    preview.dataset.previewMode = "panel";
    preview.dataset.videoUrl = item.videoUrl || "";
    preview.poster = item.dataUrl || "";
    preview.classList.toggle("is-pending", !item.dataUrl && !item.videoUrl);
    preview.setAttribute("aria-label", item.name || "当前分镜预览");
    preview.removeAttribute("src");
    if (item.videoUrl) preview.src = item.videoUrl;
    preview.load?.();
    setPreviewPlayIcon(false);
    if (play) play.disabled = !item.videoUrl;
    if (range) {
      range.value = "0";
      range.max = "0";
      range.disabled = !item.videoUrl;
    }
    if (current) current.textContent = formatPreviewTime(0);
    if (duration) duration.textContent = " / 00:00:00";
    updatePreviewNavigation();
  }

  function toggleFinalFilm() {
    if (state.showingFinalFilm) {
      const index = state.previewIndex >= 0 ? state.previewIndex : 0;
      const item = state.previewItems[index];
      if (item) setPreviewItem(item, index);
      return;
    }

    const project = state.selectedProject;
    const preview = root.querySelector("[data-claw-preview]");
    if (!project || !preview) return;

    const episode = Math.max(1, Math.trunc(Number(state.selectedEpisode) || 1));
    const videoUrl = finalFilmUrl(project, episode);
    const range = root.querySelector(".claw-range");
    const current = root.querySelector("[data-claw-current-time]");
    const duration = root.querySelector("[data-claw-duration]");
    const play = root.querySelector("[data-claw-play]");
    const scriptLabel = root.querySelector("[data-claw-script-label]");
    const scriptLead = root.querySelector(".claw-script-labels strong");
    const scriptParagraphs = [...root.querySelectorAll(".claw-script-card p")];

    state.showingFinalFilm = true;
    updateFinalFilmButton();
    updatePreviewNavigation();
    root.querySelectorAll(".claw-shot-strip .claw-shot").forEach((shot) => shot.setAttribute("aria-pressed", "false"));
    if (scriptLabel) scriptLabel.textContent = "成片";
    if (scriptLead) scriptLead.textContent = "";
    scriptParagraphs.forEach((paragraph, paragraphIndex) => {
      paragraph.textContent = paragraphIndex === 0 ? `第 ${episode} 集完整成片` : "";
      paragraph.hidden = paragraphIndex !== 0;
    });

    preview.pause?.();
    preview.dataset.previewMode = "final";
    preview.dataset.videoUrl = videoUrl;
    preview.poster = "";
    preview.classList.remove("is-pending");
    preview.setAttribute("aria-label", `${project.novelName} 第 ${episode} 集成片`);
    preview.removeAttribute("src");
    preview.src = videoUrl;
    preview.load?.();
    setPreviewPlayIcon(false);
    if (play) play.disabled = false;
    if (range) {
      range.value = "0";
      range.max = "0";
      range.disabled = true;
    }
    if (current) current.textContent = formatPreviewTime(0);
    if (duration) duration.textContent = " / 00:00:00";
  }

  function resetPreviewSurface(message) {
    const preview = root.querySelector("[data-claw-preview]");
    const range = root.querySelector(".claw-range");
    const current = root.querySelector("[data-claw-current-time]");
    const duration = root.querySelector("[data-claw-duration]");
    const play = root.querySelector("[data-claw-play]");
    const scriptLabel = root.querySelector("[data-claw-script-label]");
    const scriptLead = root.querySelector(".claw-script-labels strong");
    const scriptParagraphs = [...root.querySelectorAll(".claw-script-card p")];
    if (preview) {
      preview.pause?.();
      preview.dataset.previewMode = "panel";
      preview.dataset.videoUrl = "";
      preview.poster = "";
      preview.classList.add("is-pending");
      preview.setAttribute("aria-label", message);
      preview.removeAttribute("src");
      preview.load?.();
    }
    if (play) play.disabled = true;
    if (range) {
      range.value = "0";
      range.max = "0";
      range.disabled = true;
    }
    if (current) current.textContent = formatPreviewTime(0);
    if (duration) duration.textContent = " / 00:00:00";
    if (scriptLabel) scriptLabel.textContent = "分镜";
    if (scriptLead) scriptLead.textContent = "";
    scriptParagraphs.forEach((paragraph, paragraphIndex) => {
      paragraph.textContent = paragraphIndex === 0 ? message : "";
      paragraph.hidden = paragraphIndex !== 0;
    });
    setPreviewPlayIcon(false);
    updatePreviewNavigation();
  }

  function renderShots(images, options = {}) {
    const {
      emptyMessage = "本集暂未生成分镜",
      totalDuration: episodeDuration = null,
    } = options;
    const strip = root.querySelector(".claw-shot-strip");
    if (!strip) return;
    state.previewItems = Array.isArray(images) ? images : [];
    state.previewIndex = -1;
    state.showingFinalFilm = false;
    updateFinalFilmButton();
    const shotCount = root.querySelector("[data-claw-shot-count]");
    if (shotCount) shotCount.textContent = String(state.previewItems.length);
    const totalDuration = root.querySelector("[data-claw-total-duration]");
    const durationSeconds = Number(episodeDuration);
    if (totalDuration) {
      totalDuration.textContent = Number.isFinite(durationSeconds) && durationSeconds > 0
        ? formatPreviewTime(durationSeconds)
        : "--:--:--";
    }
    strip.replaceChildren();
    state.previewItems.forEach((item, index) => {
      const shot = document.createElement("button");
      shot.type = "button";
      shot.className = "claw-shot";
      shot.classList.toggle("is-pending", !item.dataUrl && !item.videoUrl);
      shot.setAttribute("aria-pressed", String(index === 0));
      let visual;
      if (item.dataUrl) {
        visual = document.createElement("img");
        visual.src = item.dataUrl;
        visual.alt = item.name;
        visual.loading = "lazy";
      } else {
        visual = document.createElement("span");
        visual.className = "claw-shot-placeholder";
        visual.innerHTML = item.videoUrl
          ? '<i data-lucide="clapperboard" aria-hidden="true"></i><span>视频已生成</span>'
          : '<i data-lucide="image-off" aria-hidden="true"></i><span>暂未生成</span>';
      }
      const caption = document.createElement("span");
      caption.className = "claw-shot-caption";
      const label = document.createElement("strong");
      label.textContent = `分镜${String(index + 1).padStart(2, "0")}`;
      const scene = document.createElement("span");
      scene.textContent = item.scene || "";
      caption.append(label, scene);
      shot.append(visual, caption);
      shot.addEventListener("click", () => {
        strip.querySelectorAll(".claw-shot").forEach((peer) => peer.setAttribute("aria-pressed", String(peer === shot)));
        setPreviewItem(item, index);
      });
      strip.appendChild(shot);
    });
    window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
    if (state.previewItems.length > 0) setPreviewItem(state.previewItems[0], 0);
    else resetPreviewSurface(emptyMessage);
  }

  async function loadEpisodePreview(project, episode) {
    if (!project) return;
    const normalizedEpisode = Math.max(1, Math.trunc(Number(episode) || 1));
    const loadId = ++state.previewLoadId;
    const select = root.querySelector("[data-claw-episode-select]");
    state.selectedEpisode = normalizedEpisode;
    renderEpisodeOptions(project, normalizedEpisode);
    renderShots([], { emptyMessage: "正在读取本集分镜…" });
    if (select) {
      select.disabled = true;
      select.setAttribute("aria-busy", "true");
    }

    try {
      const previewData = await api.getEpisodePreview(project.novelName, normalizedEpisode);
      if (loadId !== state.previewLoadId || state.selectedProject?.id !== project.id) return;
      const images = Array.isArray(previewData) ? previewData : previewData?.panels;
      const totalDuration = Array.isArray(previewData) ? null : previewData?.totalDuration;
      renderShots(images, { totalDuration });
    } catch (error) {
      if (loadId !== state.previewLoadId || state.selectedProject?.id !== project.id) return;
      renderShots([]);
      showToast(error instanceof Error ? error.message : "读取分镜失败");
    } finally {
      if (loadId === state.previewLoadId && select) {
        select.disabled = false;
        select.removeAttribute("aria-busy");
      }
    }
  }

  async function openProject(project) {
    const openId = ++state.projectOpenId;
    const previousProject = state.selectedProject;
    if (previousProject) await flushConversationPersist();
    if (openId !== state.projectOpenId) return;
    const sameProject = previousProject?.id === project.id;
    const previousEpisode = sameProject ? state.selectedEpisode : null;
    const activeRunProject = ["running", "stopping", "review"].includes(state.running?.status)
      && state.running?.selection?.novelName === project.novelName;
    if (!sameProject) {
      state.pendingChoices = [];
      state.progressCards = [];
      state.visualPresetCards = [];
      state.activeProgressCardId = "";
      if (!activeRunProject) {
        state.runPhase = "idle";
        state.runPhaseLabel = "";
        state.runPhaseDetail = "";
        state.runStepIndex = 0;
        state.renderWorkspaceActivated = false;
        state.agentMonitorActivated = false;
      }
    }
    state.selectedProject = project;
    if (!(sameProject && state.agentStreaming)) {
      try {
        const session = await api.getProjectConversation(project.novelName);
        if (openId !== state.projectOpenId) return;
        state.agentMessages = normalizeConversation(session?.messages);
        state.progressCards = normalizeProgressCards(session?.progressCards);
        state.visualPresetCards = normalizeVisualPresetCards(session?.visualPresetCards);
      } catch (error) {
        if (openId !== state.projectOpenId) return;
        state.agentMessages = [];
        state.progressCards = [];
        state.visualPresetCards = [];
        showToast(error instanceof Error ? error.message : "读取对话记录失败");
      }
    }
    if (activeRunProject) {
      state.runPhase = state.running?.phase || state.runPhase || "planning";
      state.runPhaseLabel = state.running?.phaseLabel || state.runPhaseLabel || "规划中";
      state.runPhaseDetail = state.running?.phaseDetail || state.runPhaseDetail || "流水线正在运行";
      if (isRenderPhase(state.runPhase)) {
        state.renderWorkspaceActivated = true;
        state.agentMonitorActivated = true;
      }
    }
    state.renderMode = project.renderMode === "full" || project.renderMode === "images_only" ? project.renderMode : "";
    if (!project.isDraft) ensureSettingsSummaryCard(project);
    if (activeRunProject) {
      ensureProgressCard(state.running);
    } else {
      let normalizedStaleCard = false;
      state.progressCards.forEach((card) => {
        if (!["active", "stopping"].includes(card.status)) return;
        card.status = "paused";
        card.label = "已暂停";
        card.detail = "当前进度已保存，发送“继续运行”可恢复";
        normalizedStaleCard = true;
      });
      if (normalizedStaleCard) scheduleConversationPersist();
    }
    if (activeRunProject) state.runStepIndex = pipelineStepIndex(state.runPhase);
    const persistedReviewCard = state.progressCards.find((card) => card.status === "review");
    const reviewEpisode = Number(persistedReviewCard?.episode || project.reviewEpisodes?.[0] || 0);
    if (reviewEpisode > 0 && (!activeRunProject || state.running?.status === "review")) {
      const reviewCopy = reviewPhaseCopy(project.articleType);
      state.running = {
        ...(activeRunProject ? state.running : {}),
        runId: String(state.running?.runId || persistedReviewCard?.runId || `review_${project.id}_${reviewEpisode}`),
        status: "review",
        selection: state.running?.selection || { ...makeSelection(), episode: reviewEpisode },
        phase: "visual_preset_review",
        phaseLabel: reviewCopy.label,
        phaseDetail: reviewCopy.detail,
        logs: [],
      };
      if (persistedReviewCard) {
        persistedReviewCard.status = "review";
        persistedReviewCard.phase = "visual_preset_review";
        persistedReviewCard.label = reviewCopy.label;
        persistedReviewCard.detail = reviewCopy.detail;
      }
      state.runPhase = "visual_preset_review";
      state.runPhaseLabel = reviewCopy.label;
      state.runPhaseDetail = reviewCopy.detail;
      state.runStepIndex = pipelineStepIndex(state.runPhase);
      ensureProgressCard(state.running);
    }
    const episodes = availableEpisodes(project);
    const activeEpisode = activeRunProject ? Number(state.running?.selection?.episode) : 0;
    const previewEpisode = activeEpisode > 0 && episodes.includes(activeEpisode)
      ? activeEpisode
      : previousEpisode && episodes.includes(previousEpisode)
      ? previousEpisode
      : defaultPreviewEpisode(project);
    state.selectedEpisode = previewEpisode;
    if (projectHasRenderedEpisode(project, previewEpisode)) {
      state.renderWorkspaceActivated = true;
      state.agentMonitorActivated = true;
      if (state.runPhase === "idle") {
        state.runPhase = "completed";
        state.runPhaseLabel = "本集已完成";
        state.runPhaseDetail = project.renderMode === "full"
          ? "本集成片已经生成，流水线已结束"
          : "本集分镜图已经生成，当前任务已结束";
      }
    }
    if (isRenderWorkspaceReady(project, previewEpisode)) {
      state.renderWorkspaceActivated = true;
      showEditorSurface();
      await loadEpisodePreview(project, previewEpisode);
    } else {
      showProjectChat(project);
    }
    const visibleReviewCard = state.visualPresetCards.findLast((card) => card.status === "active");
    if (visibleReviewCard) scrollPresetReviewIntoView(visibleReviewCard);
  }

  function makeSelection() {
    const project = state.selectedProject;
    if (!project) throw new Error("请先选择一个项目");
    return {
      novelName: project.novelName,
      sourcePath: project.sourcePath,
      episode: project.adaptedCount + 1,
      nextChapter: project.nextChapter,
      ...(typeof settingsForProject(project).ethnicity === "string" ? { ethnicity: settingsForProject(project).ethnicity } : {}),
      ...(project.aspectRatio ? { aspectRatio: project.aspectRatio } : {}),
      ...(project.renderMode ? { renderMode: project.renderMode, imagesOnly: project.renderMode === "images_only" } : {}),
      ...(project.articleType ? { articleType: project.articleType } : {}),
      ...(typeof project.reviewVisualPreset === "boolean" ? { reviewVisualPreset: project.reviewVisualPreset } : {}),
      ...(typeof project.requireFinalConfirmation === "boolean" ? { requireFinalConfirmation: project.requireFinalConfirmation } : {}),
      agentSessionId: project.agentSessionId || project.id || project.novelName,
    };
  }

  function currentAgentContext() {
    const project = state.selectedProject;
    return {
      projectName: project?.novelName || "",
      episode: state.selectedEpisode || (project ? project.adaptedCount + 1 : 1),
      phase: state.runPhase,
      phaseLabel: state.runPhaseLabel,
      phaseDetail: state.runPhaseDetail,
      runStatus: state.running?.status || "idle",
      recentLogs: (state.running?.logs || []).slice(-20),
      draftProject: Boolean(project?.isDraft),
      settings: project ? settingsForProject(project) : agentSettingsContext(),
    };
  }

  function agentPhaseVisible() {
    if (["gpu_queued", "gpu_ready", "rendering", "merging", "mg_planning", "mg_rendering", "finalizing", "postprocessing", "gpu_stopped"].includes(state.runPhase)) return true;
    return state.agentMonitorActivated && ["completed", "failed", "stopped"].includes(state.runPhase);
  }

  function runBelongsToSelectedProject() {
    const runProject = state.running?.selection?.novelName;
    return Boolean(runProject && state.selectedProject?.novelName === runProject);
  }

  function currentRunIsActive() {
    return runBelongsToSelectedProject() && ["running", "stopping"].includes(state.running?.status);
  }

  function currentRunNeedsPresetReview() {
    return runBelongsToSelectedProject() && state.running?.status === "review";
  }

  function latestProgressLog() {
    const logs = Array.isArray(state.running?.logs) ? state.running.logs : [];
    const value = cleanLine(logs.at(-1) || state.lastLog);
    if (!value || value === "就绪" || value === state.runPhaseLabel || value === state.runPhaseDetail) return "";
    return value;
  }

  function pipelineUsesGpu(imagesOnly) {
    if (typeof imagesOnly === "boolean") return !imagesOnly;
    if (typeof state.running?.selection?.imagesOnly === "boolean") return !state.running.selection.imagesOnly;
    return state.renderMode === "full";
  }

  function pipelineSteps(imagesOnly) {
    const steps = [
      { id: "prepare", label: "素材整理" },
      { id: "preset", label: "画面预设" },
      { id: "archive", label: "资源建档" },
      { id: "storyboard", label: "分镜制作" },
    ];
    if (pipelineUsesGpu(imagesOnly)) steps.push({ id: "gpu", label: "抢 GPU" });
    steps.push({ id: "render", label: pipelineUsesGpu(imagesOnly) ? "渲染成片" : "生成分镜" });
    return steps;
  }

  function pipelineStepIndex(phase, steps = pipelineSteps(), fallbackIndex = state.runStepIndex || 0) {
    const stepId = {
      planning: "prepare",
      preparing: "prepare",
      mg_annotating: "prepare",
      visual_preset: "preset",
      archiving: "archive",
      segmenting: "storyboard",
      storyboarding: "storyboard",
      ordering: "storyboard",
      gpu_queued: "gpu",
      gpu_ready: "gpu",
      rendering: "render",
      merging: "render",
      mg_planning: "render",
      mg_rendering: "render",
      finalizing: "render",
      postprocessing: "render",
      gpu_stopped: "render",
      completed: "render",
      visual_preset_review: "preset",
    }[phase];
    const index = steps.findIndex((step) => step.id === stepId);
    return index >= 0 ? index : Math.max(0, Math.min(steps.length - 1, fallbackIndex));
  }

  function ensureProgressCard(run = state.running) {
    if (!run?.selection || !state.selectedProject || run.selection.novelName !== state.selectedProject.novelName) return null;
    if (!["running", "stopping", "review"].includes(run.status)) return null;
    const runId = String(run.runId ?? "");
    let card = state.progressCards.find((item) => item.runId === runId && ["active", "stopping", "review"].includes(item.status));
    if (!card) {
      const createdAt = new Date().toISOString();
      card = {
        id: `pipeline_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        runId,
        projectName: run.selection.novelName,
        episode: Math.max(1, Math.trunc(Number(run.selection.episode) || 1)),
        messageIndex: state.agentMessages.length,
        createdAt,
        imagesOnly: Boolean(run.selection.imagesOnly),
        status: run.status === "stopping" ? "stopping" : run.status === "review" ? "review" : "active",
        phase: run.phase || "planning",
        label: run.phaseLabel || "准备开始",
        detail: run.phaseDetail || "正在启动本集制作流水线",
        log: "",
        currentIndex: 0,
        pauseNoticeAdded: false,
        settingsOnly: false,
        settingsSummary: null,
      };
      state.progressCards.push(card);
      scheduleConversationPersist();
    }
    state.activeProgressCardId = card.id;
    return card;
  }

  function progressCardForRun(runId) {
    const active = state.progressCards.find((card) => card.id === state.activeProgressCardId);
    if (active && active.runId === String(runId ?? "")) return active;
    return [...state.progressCards].reverse().find((card) => card.runId === String(runId ?? "")) || null;
  }

  function updateProgressCard(runId, patch = {}, { persist = true } = {}) {
    const card = progressCardForRun(runId) || ensureProgressCard(state.running);
    if (!card) return null;
    Object.entries(patch).forEach(([key, value]) => {
      if (value !== undefined) card[key] = value;
    });
    const steps = pipelineSteps(card.imagesOnly);
    card.currentIndex = Math.max(
      card.currentIndex || 0,
      pipelineStepIndex(card.phase, steps, card.currentIndex || 0),
    );
    if (persist) scheduleConversationPersist();
    return card;
  }

  function progressCardSnapshot(card) {
    if (!card) return null;
    const steps = pipelineSteps(card.imagesOnly);
    const stopping = card.status === "stopping";
    const paused = card.status === "paused";
    const review = card.status === "review";
    const completeAll = card.status === "completed";
    const reviewCopy = reviewPhaseCopy(
      state.running?.selection?.articleType || state.selectedProject?.articleType,
    );
    const currentIndex = completeAll
      ? steps.length - 1
      : Math.max(card.currentIndex || 0, pipelineStepIndex(card.phase, steps, card.currentIndex || 0));
    const tone = card.status === "failed"
      ? "error"
      : review
      ? "review"
      : paused
      ? "paused"
      : stopping
      ? "warning"
      : completeAll
      ? "success"
      : "active";

    return {
      id: card.id,
      status: card.status,
      tone,
      label: stopping ? "正在暂停" : review ? reviewCopy.label : paused ? "已暂停" : (card.label || "流水线运行中"),
      detail: stopping
        ? "正在保存当前进度并关闭 GPU"
        : review
        ? reviewCopy.detail
        : paused
        ? "当前进度已保存，发送“继续运行”可恢复"
        : (card.detail || "正在处理当前任务"),
      log: ["active", "failed", "review"].includes(card.status) ? card.log : "",
      currentIndex,
      completeAll,
      steps: steps.map((step, index) => ({
        ...step,
        state: completeAll || index < currentIndex ? "done" : index === currentIndex ? "current" : "pending",
      })),
    };
  }

  function renderPipelineProgressCard(snapshot) {
    const card = document.createElement("section");
    card.className = "claw-pipeline-card";
    card.dataset.pipelineCardId = snapshot.id;
    card.dataset.pipelineStatus = snapshot.status;
    card.dataset.tone = snapshot.tone;
    card.setAttribute("role", "status");
    card.setAttribute("aria-live", ["active", "stopping"].includes(snapshot.status) ? "polite" : "off");

    const head = document.createElement("div");
    head.className = "claw-pipeline-head";
    const mark = document.createElement("span");
    mark.className = "claw-pipeline-mark";
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "claw-pipeline-copy";
    const title = document.createElement("strong");
    title.className = "claw-pipeline-title";
    title.textContent = snapshot.label;
    const detail = document.createElement("span");
    detail.className = "claw-pipeline-detail";
    detail.textContent = snapshot.detail;
    copy.append(title, detail);
    if (snapshot.log) {
      const log = document.createElement("span");
      log.className = "claw-pipeline-log";
      log.textContent = snapshot.log;
      copy.appendChild(log);
    }
    head.append(mark, copy);

    const rail = document.createElement("div");
    rail.className = "claw-pipeline-rail";
    const track = document.createElement("div");
    track.className = "claw-pipeline-track";
    const edge = 50 / snapshot.steps.length;
    track.style.left = `${edge}%`;
    track.style.right = `${edge}%`;
    const fill = document.createElement("span");
    fill.className = "claw-pipeline-track-fill";
    const fillRatio = snapshot.completeAll
      ? 1
      : snapshot.steps.length > 1
      ? snapshot.currentIndex / (snapshot.steps.length - 1)
      : 0;
    fill.style.width = `${Math.max(0, Math.min(1, fillRatio)) * 100}%`;
    track.appendChild(fill);
    const steps = document.createElement("div");
    steps.className = "claw-pipeline-steps";
    steps.style.gridTemplateColumns = `repeat(${snapshot.steps.length}, minmax(0, 1fr))`;
    snapshot.steps.forEach((step) => {
      const item = document.createElement("span");
      item.className = "claw-pipeline-step";
      item.dataset.state = step.state;
      const dot = document.createElement("span");
      dot.className = "claw-pipeline-step-dot";
      dot.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "claw-pipeline-step-label";
      label.textContent = step.label;
      item.append(dot, label);
      steps.appendChild(item);
    });
    rail.append(track, steps);
    card.append(head, rail);
    return card;
  }

  const STORY_VISUAL_PRESET_FIELDS = ["场景", "人物", "景别", "角度", "镜头运动", "光影", "情绪", "语言", "独白"];

  function parseVisualPresetText(value) {
    const sourceRows = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const start = line.lastIndexOf("【");
      const validAnnotation = start > 0 && line.endsWith("】");
      return {
        original: validAnnotation ? line.slice(0, start).trim() : line,
        annotation: validAnnotation ? line.slice(start + 1, -1).trim() : "",
      };
    });
    const articleType = sourceRows.length > 0 && sourceRows.every((row) => /^画面\s*[：:]/.test(row.annotation))
      ? "essay"
      : "story";
    const fields = articleType === "essay" ? ["画面意图"] : STORY_VISUAL_PRESET_FIELDS;
    const rows = sourceRows.map((row, index) => {
      const values = articleType === "essay"
        ? [row.annotation.replace(/^画面\s*[：:]/, "").trim()]
        : row.annotation.split("|");
      return {
        index: index + 1,
        original: row.original,
        fields: Object.fromEntries(fields.map((field, fieldIndex) => [field, String(values[fieldIndex] || "").trim()])),
      };
    });
    return { articleType, fields, rows };
  }

  function renderVisualPresetCard(card) {
    const parsed = parseVisualPresetText(card?.text);
    const articleType = card?.articleType === "essay" || card?.articleType === "story"
      ? card.articleType
      : parsed.articleType;
    const wrapper = document.createElement("section");
    wrapper.className = "claw-preset-review-card";
    wrapper.dataset.presetReviewId = card?.id || "";
    wrapper.dataset.status = card?.status || "superseded";
    wrapper.dataset.articleType = articleType;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", `${articleType === "essay" ? "画面与 MG 标注" : "画面预设"}审核，共 ${parsed.rows.length} 条画面预设`);
    const head = document.createElement("div");
    head.className = "claw-preset-review-head";
    const copy = document.createElement("div");
    copy.className = "claw-preset-review-copy";
    const title = document.createElement("strong");
    title.textContent = articleType === "essay"
      ? `画面与 MG 标注审核 · ${parsed.rows.length} 条画面预设`
      : `画面预设 · ${parsed.rows.length} 条`;
    copy.appendChild(title);
    head.appendChild(copy);
    if (articleType === "essay") {
      const openMg = document.createElement("button");
      openMg.type = "button";
      openMg.className = "claw-mg-open";
      openMg.innerHTML = '<i data-lucide="external-link" aria-hidden="true"></i><span>在浏览器中查看 MG 标注</span>';
      openMg.addEventListener("click", async () => {
        if (openMg.disabled) return;
        openMg.disabled = true;
        try {
          await api.openMgAnnotation(card?.projectName || "", card?.episode || 1);
        } catch (error) {
          showToast(error instanceof Error ? error.message : "MG 标注暂时无法打开");
        } finally {
          openMg.disabled = false;
        }
      });
      head.appendChild(openMg);
    }
    wrapper.appendChild(head);

    const tableWrap = document.createElement("div");
    tableWrap.className = "claw-preset-table-wrap";
    const table = document.createElement("table");
    table.className = "claw-preset-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["序号", "原文", ...parsed.fields].forEach((label) => { const th = document.createElement("th"); th.textContent = label; headRow.appendChild(th); });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    parsed.rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      const number = document.createElement("td"); number.textContent = String(row?.index || index + 1); tr.appendChild(number);
      const original = document.createElement("td"); original.textContent = row?.original || ""; tr.appendChild(original);
      parsed.fields.forEach((field) => { const td = document.createElement("td"); td.textContent = row?.fields?.[field] || ""; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrapper.appendChild(tableWrap);
    if (card?.status === "active") {
      const actions = document.createElement("div");
      actions.className = "claw-preset-review-actions";
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "claw-preset-approve";
      approve.textContent = "确认";
      approve.disabled = currentRunNeedsPresetReview() === false;
      approve.addEventListener("click", () => confirmVisualPresetCard(card, approve));
      actions.appendChild(approve);
      wrapper.appendChild(actions);
    }
    queueMicrotask(() => window.lucide?.createIcons({ attrs: { width: 16, height: 16 } }));
    return wrapper;
  }

  function scrollPresetReviewIntoView(card) {
    if (!card?.id) return;
    window.requestAnimationFrame(() => {
      root.querySelectorAll(`[data-preset-review-id="${CSS.escape(card.id)}"]`).forEach((element) => {
        if (!element.getClientRects().length) return;
        const scroller = element.closest(".claw-home-messages, .claw-project-chat-messages, .claw-agent-messages");
        if (!scroller) return;
        const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        scroller.scrollTo({ top, left: 0, behavior: "auto" });
      });
    });
  }

  async function confirmVisualPresetCard(card, button) {
    if (!card || card.status !== "active" || button.disabled || !currentRunNeedsPresetReview()) return;
    button.disabled = true;
    const accepted = await dispatchAgentMessage("确认");
    if (!accepted) button.disabled = false;
  }

  function renderSettingsSummaryCard(settings, card) {
    const wrapper = document.createElement("section");
    wrapper.className = "claw-settings-summary-card";
    wrapper.dataset.settingsSummaryId = card?.id || "";
    const title = document.createElement("strong");
    title.textContent = "本次制作设置";
    const meta = document.createElement("div");
    meta.className = "claw-settings-summary-items";
    const article = settings?.articleType === "essay" ? "议论文 / 科普文" : settings?.articleType === "story" ? "叙事小说" : "文章类型待选择";
    const mode = settings?.renderMode === "images_only" ? "只生成分镜图" : settings?.renderMode === "full" ? "完整渲染" : "渲染模式待选择";
    const values = [
      article,
      settings?.aspectRatio || "画幅待选择",
      mode,
      settings?.ethnicity ? `人物风格：${settings.ethnicity}` : "人物风格：自动",
      typeof settings?.reviewVisualPreset === "boolean"
        ? settings.reviewVisualPreset
          ? settings?.articleType === "essay" ? "审核画面与 MG 标注" : "审核画面预设"
          : settings?.articleType === "essay" ? "不审核画面与 MG 标注" : "不审核画面预设"
        : "审核选项待选择",
      typeof settings?.requireFinalConfirmation === "boolean" ? (settings.requireFinalConfirmation ? "需要最终确认" : "最终确认选项待选择") : "最终确认选项待选择",
    ].filter(Boolean);
    values.forEach((value) => { const item = document.createElement("span"); item.textContent = value; meta.appendChild(item); });
    wrapper.append(title, meta);
    return wrapper;
  }

  function updateComposerAction(button) {
    if (!button) return;
    const stopping = currentRunIsActive() && state.running?.status === "stopping";
    const action = currentRunIsActive() ? "stop" : "send";
    button.disabled = stopping;
    button.dataset.runAction = action;
    button.setAttribute("aria-label", action === "stop" ? "暂停流水线并关闭 GPU" : "发送");
    button.title = action === "stop" ? "暂停流水线并关闭 GPU" : "发送";
    const iconName = action === "stop" ? "square" : "send";
    const currentIcon = button.querySelector("[data-lucide]")?.getAttribute("data-lucide")
      || button.querySelector("svg")?.getAttribute("data-lucide");
    if (currentIcon !== iconName) {
      button.innerHTML = `<i data-lucide="${iconName}" aria-hidden="true"></i>`;
      window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
    }
  }

  function updateComposerInput(input) {
    if (!input) return;
    if (!input.dataset.idlePlaceholder) input.dataset.idlePlaceholder = input.getAttribute("placeholder") || "继续对话";
    const active = currentRunIsActive();
    const stopping = active && state.running?.status === "stopping";
    input.readOnly = active;
    input.setAttribute("aria-readonly", String(active));
    input.placeholder = active
      ? stopping
        ? "正在保存进度并关闭 GPU"
        : "流水线运行中，暂停后可继续提问"
      : input.dataset.idlePlaceholder;
  }

  function renderChoiceCard(card) {
    const wrapper = document.createElement("section");
    wrapper.className = "claw-choice-card";
    wrapper.dataset.choiceId = card.id;
    wrapper.dataset.selected = String(Boolean(card.selectedOptionId));
    const title = document.createElement("strong");
    title.className = "claw-choice-title";
    title.textContent = card.title || "请选择";
    wrapper.appendChild(title);
    if (card.description) {
      const description = document.createElement("p");
      description.className = "claw-choice-description";
      description.textContent = card.description;
      wrapper.appendChild(description);
    }
    const options = document.createElement("div");
    options.className = "claw-choice-options";
    (Array.isArray(card.options) ? card.options : []).forEach((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "claw-choice-option";
      button.disabled = Boolean(card.selectedOptionId) || currentRunIsActive();
      button.dataset.optionId = option.id;
      const label = document.createElement("strong");
      label.textContent = option.label;
      button.appendChild(label);
      if (option.description) {
        const detail = document.createElement("span");
        detail.textContent = option.description;
        button.appendChild(detail);
      }
      if (card.selectedOptionId === option.id) button.setAttribute("aria-pressed", "true");
      button.addEventListener("click", () => chooseAgentOption(card, option, wrapper));
      options.appendChild(button);
    });
    wrapper.appendChild(options);
    return wrapper;
  }

  async function chooseAgentOption(card, option, wrapper) {
    if (card.selectedOptionId || !option?.id) return;
    card.selectedOptionId = option.id;
    card.selectedOptionLabel = option.label;
    wrapper.dataset.selected = "true";
    wrapper.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    wrapper.querySelector(`[data-option-id="${CSS.escape(option.id)}"]`)?.setAttribute("aria-pressed", "true");
    state.agentActivityLabel = "AI 正在处理";
    state.agentActivityDetail = "正在处理你的选择";
    state.agentStreaming = true;
    appendAgentMessage("user", option.label);
    updateProjectChatControls();
    updateAgentPanel();
    try {
      const response = await api.sendAgentChoice({ cardId: card.id, optionId: option.id, optionLabel: option.label });
      if (!response?.accepted) appendAgentMessage("system", "选择没有送达主 Agent。");
    } catch (error) {
      appendAgentMessage("system", error instanceof Error ? error.message : "选择暂时无法送达主 Agent");
    }
  }

  function renderConversationList(list, messageClass) {
    if (!list) return;
    list.replaceChildren();
    const cardsByIndex = new Map();
    const addCard = (messageIndex, order, render) => {
      const index = Math.max(0, Math.min(state.agentMessages.length, Number(messageIndex) || 0));
      cardsByIndex.set(index, [...(cardsByIndex.get(index) || []), { order, render }]);
    };
    state.pendingChoices.forEach((card) => {
      addCard(card.messageIndex, `0_${card.id}`, () => renderChoiceCard(card));
    });
    state.progressCards.filter((card) => !card.settingsOnly).forEach((card) => {
      addCard(card.messageIndex, `1_${card.createdAt}_${card.id}`, () => renderPipelineProgressCard(progressCardSnapshot(card)));
    });
    state.visualPresetCards.forEach((card) => {
      addCard(card.messageIndex, `2_${card.createdAt}_${card.id}`, () => renderVisualPresetCard(card));
    });
    state.progressCards.forEach((card) => {
      if (!card.settingsOnly || !card.settingsSummary) return;
      addCard(card.messageIndex, `3_${card.createdAt}_${card.id}`, () => renderSettingsSummaryCard(card.settingsSummary, card));
    });
    const appendMessage = (message) => {
      const item = document.createElement("div");
      item.className = messageClass;
      item.dataset.role = message.role;
      item.textContent = message.text;
      list.appendChild(item);
    };
    for (let index = 0; index <= state.agentMessages.length; index += 1) {
      (cardsByIndex.get(index) || [])
        .sort((a, b) => a.order.localeCompare(b.order))
        .forEach((entry) => list.appendChild(entry.render()));
      if (index < state.agentMessages.length) appendMessage(state.agentMessages[index]);
    }
    list.scrollTop = list.scrollHeight;
  }

  function renderAgentMessages() {
    renderConversationList(root.querySelector("[data-agent-messages]"), "claw-agent-message");
  }

  function renderProjectConversation() {
    renderConversationList(root.querySelector("[data-project-chat-messages]"), "claw-project-chat-message");
  }

  function renderHomeConversation() {
    renderConversationList(root.querySelector("[data-home-messages]"), "claw-home-message");
  }

  function scheduleConversationPersist() {
    if (!state.selectedProject) return;
    clearTimeout(state.conversationPersistTimer);
    state.conversationPersistTimer = setTimeout(() => {
      state.conversationPersistTimer = null;
      persistConversationSnapshot();
    }, 180);
  }

  function ensureSettingsSummaryCard(project = state.selectedProject) {
    if (!project || project.isDraft) return null;
    const existing = state.progressCards.find((card) => card.settingsOnly);
    if (existing) {
      existing.settingsSummary = settingsForProject(project);
      return existing;
    }
    const createdAt = new Date().toISOString();
    const card = {
      id: `settings_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      runId: "",
      projectName: project.novelName,
      episode: Math.max(1, Number(project.nextChapter) || 1),
      messageIndex: state.agentMessages.length,
      createdAt,
      imagesOnly: project.renderMode === "images_only",
      status: "approved",
      phase: "settings",
      label: "",
      detail: "",
      log: "",
      currentIndex: 0,
      pauseNoticeAdded: false,
      settingsOnly: true,
      settingsSummary: settingsForProject(project),
    };
    state.progressCards.push(card);
    scheduleConversationPersist();
    return card;
  }

  function persistConversationSnapshot() {
    if (!state.selectedProject) {
      return state.conversationPersistPromise;
    }
    const novelName = state.selectedProject.novelName;
    const messages = normalizeConversation(state.agentMessages);
    const progressCards = normalizeProgressCards(state.progressCards);
    const visualPresetCards = normalizeVisualPresetCards(state.visualPresetCards);
    const operation = state.conversationPersistPromise
      .catch(() => {})
      .then(() => api.updateProjectConversation(novelName, { messages, progressCards, visualPresetCards }));
    state.conversationPersistPromise = operation.catch((error) => {
      showToast(error instanceof Error ? error.message : "保存对话记录失败");
      return null;
    });
    return state.conversationPersistPromise;
  }

  function flushConversationPersist() {
    clearTimeout(state.conversationPersistTimer);
    state.conversationPersistTimer = null;
    return persistConversationSnapshot();
  }

  function appendAgentMessage(role, text) {
    const value = String(text || "").trim();
    if (!value) return;
    state.agentMessages.push({ role, text: value });
    renderAgentMessages();
    renderHomeConversation();
    renderProjectConversation();
    flushConversationPersist();
  }

  function appendPipelinePauseNotice(card) {
    if (!card || card.pauseNoticeAdded) return;
    card.pauseNoticeAdded = true;
    appendAgentMessage(
      "assistant",
      "流水线已暂停，当前进度已保存，GPU 已关闭。你现在可以继续提问；发送“继续运行”后，将从磁盘中已保存的阶段进度继续制作，实际进度以新的桌面端进度卡为准。",
    );
  }

  function updateAgentPanel() {
    const panel = root.querySelector("[data-agent-panel]");
    if (!panel) return;
    const visible = agentPhaseVisible() && Boolean(state.selectedProject) && Boolean(editorScreen && !editorScreen.hidden);
    panel.hidden = !visible;
    editorScreen?.classList.toggle("has-agent-panel", visible);
    editorScreen?.classList.toggle("is-agent-collapsed", visible && state.agentCollapsed);
    updateComposerInput(panel.querySelector("[data-agent-input]"));
    updateComposerAction(panel.querySelector("[data-agent-send]"));
    renderAgentMessages();
  }

  function updateProjectChatControls() {
    updateComposerInput(root.querySelector("[data-project-chat-input]"));
    updateComposerAction(root.querySelector("[data-project-chat-send]"));
    renderProjectConversation();
  }

  async function stopRun() {
    try {
      if (!state.running || state.running.status !== "running" || !runBelongsToSelectedProject()) return;
      const runId = state.running.runId;
      state.running = { ...state.running, status: "stopping", statusText: "正在暂停任务…" };
      state.runPhase = "stopped";
      state.runPhaseLabel = "正在暂停";
      state.runPhaseDetail = "正在保存当前进度并关闭 GPU";
      updateProgressCard(runId, {
        status: "stopping",
        phase: "stopped",
        label: state.runPhaseLabel,
        detail: state.runPhaseDetail,
      });
      updateProjectChatControls();
      updateAgentPanel();
      await api.stopRun();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "暂停任务失败");
    }
  }

  function submitConversation(source) {
    if (currentRunIsActive()) {
      stopRun();
      return;
    }
    sendAgentMessage(source);
  }

  function injectAgentPanel() {
    if (!editorScreen || editorScreen.querySelector("[data-agent-panel]")) return;
    const panel = document.createElement("aside");
    panel.className = "claw-agent-panel";
    panel.dataset.agentPanel = "true";
    panel.hidden = true;
    panel.innerHTML = `
      <button type="button" class="claw-icon-control claw-agent-collapse" data-agent-collapse aria-label="收回对话" aria-expanded="true"><i data-lucide="panel-right-close" aria-hidden="true"></i></button>
      <div class="claw-agent-messages" data-agent-messages></div>
      <form class="claw-agent-composer" data-agent-composer><textarea data-agent-input rows="1" placeholder="继续对话" aria-label="继续项目对话"></textarea><button type="submit" class="claw-agent-send" data-agent-send aria-label="发送"><i data-lucide="send" aria-hidden="true"></i></button></form>`;
    editorScreen.appendChild(panel);
    panel.querySelector("[data-agent-collapse]")?.addEventListener("click", () => {
      state.agentCollapsed = !state.agentCollapsed;
      const button = panel.querySelector("[data-agent-collapse]");
      if (button) {
        button.setAttribute("aria-expanded", String(!state.agentCollapsed));
        button.setAttribute("aria-label", state.agentCollapsed ? "展开对话" : "收回对话");
        button.innerHTML = `<i data-lucide="${state.agentCollapsed ? "panel-right-open" : "panel-right-close"}" aria-hidden="true"></i>`;
      }
      updateAgentPanel();
      window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
    });
    panel.querySelector("[data-agent-composer]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitConversation("panel");
    });
    panel.querySelector("[data-agent-input]")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submitConversation("panel");
      }
    });
    window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
  }

  async function dispatchAgentMessage(value) {
    const text = String(value || "").trim();
    if (!text) return;
    if (!state.selectedProject || state.selectedProject.isDraft) {
      state.homeSourceText = [...state.agentMessages.filter((message) => message.role === "user").map((message) => message.text), text]
        .filter(Boolean)
        .join("\n\n");
    }
    appendAgentMessage("user", text);
    state.agentStreaming = true;
    state.agentActivityLabel = "AI 正在处理";
    state.agentActivityDetail = "正在理解你的要求";
    updateProjectChatControls();
    updateAgentPanel();
    try {
      const response = await api.sendAgentMessage({
        text,
        selection: state.selectedProject ? makeSelection() : null,
        conversation: state.agentMessages,
      context: {
          ...currentAgentContext(),
          draftText: state.homeSourceText || text,
          inputPath: state.pendingInput?.path || "",
          inputKind: state.pendingInput?.kind || "",
          settings: state.selectedProject ? settingsForProject(state.selectedProject) : agentSettingsContext(),
        },
      });
      if (!response?.accepted) appendAgentMessage("system", "消息没有送达主 Agent。");
      return Boolean(response?.accepted);
    } catch (error) {
      appendAgentMessage("system", error instanceof Error ? error.message : "主 Agent 暂不可用");
      state.agentStreaming = false;
      return false;
    }
  }

  async function sendAgentMessage(source = "panel") {
    const selector = source === "landing"
      ? ".claw-compose-textarea"
      : source === "home"
      ? "[data-project-chat-input]"
      : "[data-agent-input]";
    const input = root.querySelector(selector);
    const typedText = String(input?.value || "").trim();
    const text = typedText || (source === "landing" && state.pendingInput
      ? "请读取我选择的章节素材，先和我确认项目配置。"
      : "");
    if (!text) {
      if (source === "landing") showToast("请先输入文稿或选择章节文件夹");
      return;
    }
    if (input) input.value = "";
    if (source === "landing") {
      const count = root.querySelector("[data-claw-compose-count]");
      if (count) count.textContent = "0 / 10000";
      showConversationSurface();
    }
    return dispatchAgentMessage(text);
  }

  async function chooseInput(kind) {
    try {
      const selected = await api.chooseSource(kind);
      if (!selected) return;
      state.pendingInput = selected;
      const status = root.querySelector("[data-claw-upload-status]");
      if (status) {
        status.textContent = selected.kind === "directory" ? `已选择文件夹：${selected.path}` : `已选择文件：${selected.path}`;
        status.hidden = false;
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "选择文件失败");
    }
  }

  async function getSelectedFilePath(file) {
    if (!file) return "";
    try {
      const resolved = api.getFilePath?.(file);
      if (resolved) return resolved;
    } catch {
      // 某些拖拽对象无法交给 Electron 文件路径 API，继续使用可用的公开属性。
    }
    return typeof file.path === "string" ? file.path : "";
  }

  function directoryPathFromRelativeFile(filePath, relativePath) {
    if (!filePath || !relativePath) return "";
    const parts = String(relativePath).split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2) return "";
    let directory = filePath;
    for (let index = 0; index < parts.length - 1; index += 1) {
      directory = directory.replace(/[\\/][^\\/]*$/, "");
    }
    return directory;
  }

  function bindPreviewControls() {
    const editor = editorScreen;
    const preview = root.querySelector("[data-claw-preview]");
    const play = root.querySelector("[data-claw-play]");
    const previous = root.querySelector("[data-claw-prev]");
    const next = root.querySelector("[data-claw-next]");
    const range = root.querySelector(".claw-range");
    const current = root.querySelector("[data-claw-current-time]");
    const duration = root.querySelector("[data-claw-duration]");
    const collapse = root.querySelector("[data-claw-collapse]");
    const finalFilm = root.querySelector("[data-claw-final-film]");
    if (!preview || !play || !range) return;

    const selectPreview = (index) => {
      const shot = root.querySelectorAll(".claw-shot")[index];
      shot?.click();
      shot?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };

    if (collapse && collapse.dataset.clawRuntimeBound !== "true") {
      collapse.dataset.clawRuntimeBound = "true";
      collapse.addEventListener("click", () => {
        const collapsed = editor?.classList.toggle("is-script-collapsed") || false;
        collapse.setAttribute("aria-expanded", String(!collapsed));
        collapse.setAttribute("aria-label", collapsed ? "展开文稿" : "收起文稿");
        collapse.innerHTML = `<i data-lucide="${collapsed ? "panel-left-open" : "panel-left-close"}" aria-hidden="true"></i>`;
        window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
      });
    }

    play.dataset.clawRuntimeBound = "true";
    play.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!preview.dataset.videoUrl) return showToast("当前分镜还没有可播放的视频");
      try {
        if (preview.paused) await preview.play();
        else preview.pause();
      } catch (error) {
        setPreviewPlayIcon(false);
        showToast(error instanceof Error ? error.message : "视频播放失败");
      }
    });

    previous?.addEventListener("click", () => selectPreview(Math.max(0, state.previewIndex - 1)));
    next?.addEventListener("click", () => selectPreview(Math.min(state.previewItems.length - 1, state.previewIndex + 1)));
    finalFilm?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleFinalFilm();
    });

    range.dataset.clawRuntimeBound = "true";
    range.addEventListener("input", (event) => {
      event.stopImmediatePropagation();
      if (!preview.dataset.videoUrl) return;
      preview.currentTime = Number(range.value) || 0;
      if (current) current.textContent = formatPreviewTime(preview.currentTime);
    });

    preview.addEventListener("loadedmetadata", () => {
      const total = Number.isFinite(preview.duration) ? preview.duration : 0;
      range.max = String(total);
      range.disabled = !total;
      if (duration) duration.textContent = ` / ${formatPreviewTime(total)}`;
      if (preview.dataset.previewMode === "final") {
        const totalDuration = root.querySelector("[data-claw-total-duration]");
        if (totalDuration) totalDuration.textContent = formatPreviewTime(total);
      }
    });
    preview.addEventListener("timeupdate", () => {
      if (current) current.textContent = formatPreviewTime(preview.currentTime);
      if (Number.isFinite(preview.duration)) range.value = String(preview.currentTime);
    });
    preview.addEventListener("play", () => setPreviewPlayIcon(true));
    preview.addEventListener("pause", () => setPreviewPlayIcon(false));
    preview.addEventListener("ended", () => setPreviewPlayIcon(false));
    preview.addEventListener("error", () => {
      if (!preview.dataset.videoUrl) return;
      setPreviewPlayIcon(false);
      if (preview.dataset.previewMode === "final") {
        const episode = state.selectedEpisode;
        const index = state.previewIndex >= 0 ? state.previewIndex : 0;
        const item = state.previewItems[index];
        if (item) setPreviewItem(item, index);
        else {
          state.showingFinalFilm = false;
          updateFinalFilmButton();
          updatePreviewNavigation();
          preview.dataset.videoUrl = "";
          preview.removeAttribute("src");
          preview.load?.();
        }
        showToast(`第 ${episode} 集暂未生成成片`);
        return;
      }
      showToast("当前分镜视频无法加载");
    });
    updatePreviewNavigation();
  }

  function bindInteractions() {
    bindSettingsControls();
    bindSystemSettingsControls();
    bindPreviewControls();
    root.querySelector("[data-claw-episode-select]")?.addEventListener("change", (event) => {
      if (!state.selectedProject) return;
      const project = state.selectedProject;
      const episode = Math.max(1, Math.trunc(Number(event.currentTarget.value) || 1));
      state.selectedEpisode = episode;
      state.showingFinalFilm = false;
      if (isRenderWorkspaceReady(project, episode)) {
        state.renderWorkspaceActivated = true;
        showEditorSurface();
        loadEpisodePreview(project, episode);
      } else {
        state.renderWorkspaceActivated = false;
        showProjectChat(project);
      }
    });
    root.querySelectorAll("[data-claw-page]").forEach((button) => {
      button.addEventListener("click", () => {
        const page = button.dataset.clawPage;
        if (page === "home") showHomeLanding({ reset: true });
        else showLibraryView(page);
        if (page === "assets") {
          const project = state.selectedProject || state.projects[0];
          if (project) renderAssets(project);
        }
      });
    });
    root.querySelectorAll("[data-claw-view-target=home]").forEach((button) => {
      button.addEventListener("click", (event) => { event.preventDefault(); showHomeLanding({ reset: true }); });
    });
    root.querySelector("[data-claw-back]")?.addEventListener("click", (event) => {
      event.preventDefault(); showLibraryView("projects");
    });
    root.querySelector("[data-chat-nav-trigger]")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const trigger = event.currentTarget;
      const menu = root.querySelector("[data-chat-nav-menu]");
      if (!menu) return;
      menu.hidden = !menu.hidden;
      trigger.setAttribute("aria-expanded", String(!menu.hidden));
    });
    root.querySelector("[data-chat-nav-menu]")?.addEventListener("click", (event) => event.stopPropagation());
    root.querySelector("[data-chat-go-home]")?.addEventListener("click", () => showHomeLanding({ reset: true }));
    root.querySelector("[data-chat-go-projects]")?.addEventListener("click", () => showLibraryView("projects"));
    document.addEventListener("click", closeChatMenu);
    root.querySelectorAll("[data-claw-open-input]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const kind = button.dataset.clawOpenInput === "file" ? "file" : "directory";
        const menu = root.querySelector("[data-claw-upload-menu]");
        const picker = root.querySelector("[data-claw-upload-pick]");
        if (menu) menu.hidden = true;
        picker?.setAttribute("aria-expanded", "false");
        await chooseInput(kind);
      });
    });
    root.querySelectorAll("[data-claw-upload-input]").forEach((input) => {
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        const filePath = await getSelectedFilePath(file);
        const selectedPath = input.dataset.clawUploadInput === "directory"
          ? directoryPathFromRelativeFile(filePath, file?.webkitRelativePath)
          : filePath;
        if (!selectedPath) return;
        try {
          const selected = await api.inspectSource(selectedPath);
          if (!selected) throw new Error("所选素材不可用");
          state.pendingInput = selected;
          root.querySelector("[data-claw-upload-menu]")?.setAttribute("hidden", "true");
          showToast(selected.kind === "directory" ? "已添加章节文件夹" : "已添加章节文件");
        } catch (error) {
          showToast(error instanceof Error ? error.message : "读取素材失败");
        }
      });
    });
    root.querySelector("[data-claw-upload-pick]")?.addEventListener("drop", async (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      const filePath = await getSelectedFilePath(file);
      const selectedPath = directoryPathFromRelativeFile(filePath, file?.webkitRelativePath) || filePath;
      if (!selectedPath) return;
      try {
        const selected = await api.inspectSource(selectedPath);
        if (!selected) throw new Error("所选素材不可用");
        state.pendingInput = selected;
      } catch (error) {
        showToast(error instanceof Error ? error.message : "读取素材失败");
      }
    });

    root.querySelector("[data-claw-create]")?.addEventListener("click", (event) => {
      event.preventDefault();
      sendAgentMessage("landing");
    });
    root.querySelector(".claw-compose-textarea")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        sendAgentMessage("landing");
      }
    });

    root.querySelector("[data-project-chat-composer]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitConversation("home");
    });
    root.querySelector("[data-project-chat-input]")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submitConversation("home");
      }
    });
  }

  api.onRunLog((event) => {
    const line = cleanLine(event?.line);
    if (!line) return;
    state.lastLog = line;
    if (state.running) {
      state.running.logs = [...(state.running.logs || []).slice(-79), line];
      state.running.statusText = line;
      updateProgressCard(event?.runId ?? state.running.runId, { log: latestProgressLog() });
    }
    updateProjectChatControls();
    updateAgentPanel();
  });

  api.onRunPhase((event) => {
    if (!event || (state.running && ["running", "stopping"].includes(state.running.status) && event.runId !== state.running.runId)) return;
    state.runPhase = event.phase || state.runPhase;
    const pausedEvent = state.runPhase === "stopped";
    const pausing = state.running?.status === "stopping";
    state.runPhaseLabel = pausedEvent
      ? pausing ? "正在暂停" : "已暂停"
      : event.label || state.runPhaseLabel;
    state.runPhaseDetail = pausedEvent
      ? pausing ? "正在保存当前进度并关闭 GPU" : "当前进度已保存，发送“继续运行”可恢复"
      : event.detail || state.runPhaseDetail;
    if (!["failed", "stopped"].includes(state.runPhase)) {
      state.runStepIndex = Math.max(state.runStepIndex || 0, pipelineStepIndex(state.runPhase));
    }
    const renderStarted = ["gpu_queued", "gpu_ready", "rendering", "merging", "mg_planning", "mg_rendering", "finalizing", "postprocessing", "gpu_stopped"].includes(state.runPhase);
    if (renderStarted) {
      state.renderWorkspaceActivated = true;
      state.agentMonitorActivated = true;
      const project = state.selectedProject;
      const runProject = state.running?.selection?.novelName;
      if (project && project.novelName === runProject && editorScreen?.hidden) {
        const episode = Number(state.running?.selection?.episode) || state.selectedEpisode;
        state.selectedEpisode = episode;
        showEditorSurface();
        loadEpisodePreview(project, episode).catch(() => {});
      }
    }
    if (state.running) {
      state.running.phase = state.runPhase;
      state.running.phaseLabel = state.runPhaseLabel;
      state.running.phaseDetail = state.runPhaseDetail;
      state.running.statusText = state.runPhaseDetail || state.runPhaseLabel;
      const terminalStatus = state.runPhase === "completed"
        ? "completed"
        : state.runPhase === "failed"
        ? "failed"
        : undefined;
      updateProgressCard(event.runId, {
        status: pausing ? "stopping" : state.running.status === "stopped" ? "paused" : terminalStatus,
        phase: state.runPhase,
        label: state.runPhaseLabel,
        detail: state.runPhaseDetail,
        log: latestProgressLog(),
        currentIndex: state.runStepIndex,
      });
    }
    updateProjectChatControls();
    updateAgentPanel();
  });

  api.onRunReviewApproved?.((event) => {
    const oldCard = progressCardForRun(event?.runId);
    if (oldCard) oldCard.status = "approved";
    const activePresetCard = [...state.visualPresetCards].reverse().find((card) => card.status === "active");
    if (activePresetCard) activePresetCard.status = "approved";
    scheduleConversationPersist();
    renderAgentMessages();
    renderHomeConversation();
    renderProjectConversation();
  });

  api.onAgentEvent((event) => {
    if (!event) return;
    if (event.type === "choice" && event.card?.id) {
      const existing = state.pendingChoices.find((item) => item.id === String(event.card.id));
      const card = {
        id: String(event.card.id),
        title: String(event.card.title || "请选择"),
        description: String(event.card.description || ""),
        options: Array.isArray(event.card.options) ? event.card.options.map((option) => ({
          id: String(option?.id || ""),
          label: String(option?.label || ""),
          description: String(option?.description || ""),
        })).filter((option) => option.id && option.label) : [],
        messageIndex: existing?.messageIndex ?? state.agentMessages.length,
        selectedOptionId: existing?.selectedOptionId || "",
        selectedOptionLabel: existing?.selectedOptionLabel || "",
      };
      const existingIndex = state.pendingChoices.findIndex((item) => item.id === card.id);
      if (existingIndex >= 0) state.pendingChoices.splice(existingIndex, 1, card);
      else state.pendingChoices.push(card);
      state.agentActivityLabel = "等待你的选择";
      state.agentActivityDetail = card.title;
      renderAgentMessages();
      renderHomeConversation();
      renderProjectConversation();
      updateProjectChatControls();
      updateAgentPanel();
      return;
    }
    if (event.type === "tool" && event.toolName) {
      const toolLabels = {
        get_pipeline_status: "正在读取流水线状态",
        get_project_config: "正在检查项目配置",
        request_user_choice: "正在准备选择项",
        create_project: "正在确认项目配置",
        start_pipeline: "正在启动流水线",
        pause_pipeline: "正在暂停流水线",
        show_visual_preset: "正在展示画面预设",
        revise_visual_preset: "正在根据意见修改画面预设",
        revise_mg_annotation: "正在根据意见修改 MG 标注",
      };
      state.agentActivityLabel = event.status === "error"
        ? "操作未完成"
        : event.status === "done"
        ? "AI 正在处理"
        : (toolLabels[event.toolName] || "AI 正在处理");
      state.agentActivityDetail = event.status === "done" ? "正在整理结果" : "";
      updateProjectChatControls();
      updateAgentPanel();
      return;
    }
    if (event.type === "visual_preset" && String(event.text || "").trim()) {
      if (!state.selectedProject || event.projectName !== state.selectedProject.novelName) return;
      state.visualPresetCards.forEach((card) => {
        if (card.status === "active") card.status = "superseded";
      });
      const card = {
        id: `visual_preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        projectName: event.projectName,
        episode: Math.max(1, Math.trunc(Number(event.episode) || 1)),
        messageIndex: state.agentMessages.length,
        createdAt: new Date().toISOString(),
        status: "active",
        articleType: event.articleType === "essay" ? "essay" : "story",
        text: String(event.text),
      };
      state.visualPresetCards.push(card);
      const reviewCopy = reviewPhaseCopy(card.articleType);
      const progressCard = progressCardForRun(state.running?.runId);
      if (progressCard) {
        progressCard.status = "review";
        progressCard.phase = "visual_preset_review";
        progressCard.label = reviewCopy.label;
        progressCard.detail = card.articleType === "essay"
          ? "画面预设已展示，可打开 MG 标注并确认或继续提出修改意见"
          : "画面预设已展示，请确认或继续提出修改意见";
      }
      state.agentActivityLabel = reviewCopy.activity;
      state.agentActivityDetail = card.articleType === "essay"
        ? "可以浏览 MG 标注、确认，或继续提出修改意见"
        : "可以确认，也可以继续提出修改意见";
      scheduleConversationPersist();
      renderAgentMessages();
      renderHomeConversation();
      renderProjectConversation();
      updateProjectChatControls();
      updateAgentPanel();
      scrollPresetReviewIntoView(card);
      return;
    }
    if (["project_created", "project_renamed"].includes(event.type) && event.project) {
      if (!event.provisional) state.pendingInput = null;
      state.selectedProject = event.project;
      state.selectedEpisode = Number(event.selection?.episode) || 1;
      state.renderMode = event.project.renderMode === "full" || event.project.renderMode === "images_only" ? event.project.renderMode : "";
      state.projects = [
        ...state.projects.filter((project) => project.id !== event.project.id && project.id !== event.previousProjectId),
        event.project,
      ];
      renderProjects();
      renderAssetProjectOptions();
      if (!event.provisional) ensureSettingsSummaryCard(event.project);
      flushConversationPersist();
      showProjectChat(event.project);
      return;
    }
    if (event.type === "assistant_delta" && event.delta) {
      const last = state.agentMessages.at(-1);
      if (state.agentStreaming && last?.role === "assistant") last.text += event.delta;
      else state.agentMessages.push({ role: "assistant", text: event.delta });
      state.agentStreaming = true;
      state.agentActivityLabel = "AI 正在回复";
      state.agentActivityDetail = "";
      renderAgentMessages();
      renderHomeConversation();
      renderProjectConversation();
      updateProjectChatControls();
      updateAgentPanel();
      scheduleConversationPersist();
      return;
    }
    if (event.type === "assistant_end") {
      state.agentStreaming = false;
      state.agentActivityLabel = "";
      state.agentActivityDetail = "";
      flushConversationPersist();
      renderHomeConversation();
      renderProjectConversation();
      updateProjectChatControls();
      updateAgentPanel();
      return;
    }
    if (event.type === "error") {
      state.agentStreaming = false;
      state.agentActivityLabel = "";
      state.agentActivityDetail = "";
      appendAgentMessage("system", event.message || "主 Agent 发生错误");
      updateProjectChatControls();
      updateAgentPanel();
    }
  });

  api.onRunState(async (event) => {
    if (!event || (state.running && ["running", "stopping"].includes(state.running.status) && event.runId !== state.running.runId)) return;
    if (event.status === "running") {
      const sameRun = state.running?.runId === event.runId;
      state.running = { ...(sameRun ? state.running : {}), runId: event.runId, status: "running", statusText: "运行中…", selection: event.selection, logs: sameRun ? (state.running?.logs || []) : [] };
      state.runPhase = "planning";
      state.runPhaseLabel = "准备开始";
      state.runPhaseDetail = "正在启动本集制作流水线";
      state.runStepIndex = 0;
      const card = ensureProgressCard(state.running);
      if (card) {
        Object.assign(card, {
          status: "active",
          phase: "planning",
          label: state.runPhaseLabel,
          detail: state.runPhaseDetail,
          log: "",
          currentIndex: 0,
        });
        scheduleConversationPersist();
      }
    } else if (event.status === "review") {
      state.running = { ...(state.running || {}), runId: event.runId, status: "review", selection: event.selection || state.running?.selection };
      const reviewCopy = reviewPhaseCopy(state.running?.selection?.articleType || state.selectedProject?.articleType);
      state.runPhase = "visual_preset_review";
      state.runPhaseLabel = reviewCopy.label;
      state.runPhaseDetail = reviewCopy.detail;
      const card = progressCardForRun(event.runId) || ensureProgressCard(state.running);
      if (card) {
        card.status = "review";
        card.phase = "visual_preset_review";
        card.label = state.runPhaseLabel;
        card.detail = state.runPhaseDetail;
      }
      state.agentActivityLabel = reviewCopy.activity;
      state.agentActivityDetail = "可以确认，也可以直接提出修改意见";
      scheduleConversationPersist();
    } else if (["stopping", "stopped"].includes(event.status)) {
      state.running = { ...(state.running || {}), runId: event.runId, status: event.status, statusText: event.status === "stopping" ? "正在暂停任务…" : "任务已暂停" };
      state.agentMonitorActivated = true;
      state.runPhase = event.status === "stopping" ? "stopped" : "stopped";
      state.runPhaseLabel = event.status === "stopping" ? "正在暂停" : "已暂停";
      state.runPhaseDetail = event.status === "stopping"
        ? "正在保存当前进度并关闭 GPU"
        : "当前进度已保存，发送“继续运行”可恢复";
      const card = updateProgressCard(event.runId, {
        status: event.status === "stopping" ? "stopping" : "paused",
        phase: "stopped",
        label: state.runPhaseLabel,
        detail: state.runPhaseDetail,
        log: "",
        currentIndex: state.runStepIndex,
      });
      if (event.status === "stopped") appendPipelinePauseNotice(card);
    } else {
      const message = event.status === "done" ? "任务完成" : "任务失败，请查看运行日志";
      state.running = { ...(state.running || {}), runId: event.runId, status: event.status, statusText: message };
      state.agentMonitorActivated = true;
      state.runPhase = event.status === "done" ? "completed" : "failed";
      state.runPhaseLabel = event.status === "done" ? "已完成" : "运行失败";
      state.runPhaseDetail = event.status === "done" ? "流水线已结束" : "请查看运行日志";
      if (event.status === "done") state.runStepIndex = pipelineSteps().length - 1;
      updateProgressCard(event.runId, {
        status: event.status === "done" ? "completed" : "failed",
        phase: state.runPhase,
        label: state.runPhaseLabel,
        detail: state.runPhaseDetail,
        log: event.status === "failed" ? latestProgressLog() : "",
        currentIndex: state.runStepIndex,
      });
      state.lastLog = message;
      showToast(message);
      state.projects = await api.getProjects();
      renderProjects();
      renderAssetProjectOptions();
      if (state.selectedProject) {
        state.selectedProject = state.projects.find((project) => project.id === state.selectedProject.id) || state.selectedProject;
        await openProject(state.selectedProject);
      }
    }
    updateProjectChatControls();
    updateAgentPanel();
  });

  async function init() {
    bindInteractions();
    try {
      await loadSettings();
      state.projects = await api.getProjects();
      renderProjects();
      renderAssetProjectOptions();
      const activeRun = await api.getActiveRun();
      if (activeRun) {
        const reviewCopy = reviewPhaseCopy(activeRun.selection?.articleType);
        state.running = {
          runId: activeRun.runId,
          status: activeRun.status === "stopping" ? "stopping" : activeRun.status === "review" ? "review" : "running",
          statusText: activeRun.status === "stopping" ? "正在暂停任务…" : activeRun.status === "review" ? reviewCopy.label : "运行中…",
          selection: activeRun.selection,
          phase: activeRun.phase,
          phaseLabel: activeRun.phaseLabel,
          phaseDetail: activeRun.phaseDetail,
          logs: Array.isArray(activeRun.logs) ? activeRun.logs : [],
        };
        state.runPhase = activeRun.phase || "planning";
        state.runPhaseLabel = activeRun.phaseLabel || "规划中";
        state.runPhaseDetail = activeRun.phaseDetail || "流水线正在运行";
        state.runStepIndex = pipelineStepIndex(state.runPhase);
        state.agentMonitorActivated = isRenderPhase(state.runPhase);
        if (activeRun.status === "review") {
          state.runPhase = "visual_preset_review";
          state.runPhaseLabel = reviewCopy.label;
          state.runPhaseDetail = reviewCopy.detail;
          state.runStepIndex = pipelineStepIndex(state.runPhase);
          ensureProgressCard(state.running);
        }
      }
      injectAgentPanel();
      updateProjectChatControls();
      updateAgentPanel();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "读取项目失败");
    }
  }

  window.addEventListener("beforeunload", () => {
    flushConversationPersist();
  });

  init();
})();
