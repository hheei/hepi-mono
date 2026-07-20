# Graph Report - packages  (2026-07-18)

## Corpus Check
- 54 files · ~26,843 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 532 nodes · 1133 edges · 12 communities
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.64)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Codex Skill Picker
- SSH Session Management
- SSH Tool Registration
- Extcore TUI Components
- Extcore Settings Providers
- Codex Interaction Tests
- Loadout State UI
- Extcore Settings Panel
- Package Architecture Docs
- Shared Settings Storage
- Inturl Path Shortcuts
- Settings Table UI

## God Nodes (most connected - your core abstractions)
1. `SessionManager` - 31 edges
2. `SettingsState` - 20 edges
3. `SettingGroup` - 15 edges
4. `registerExtensionSettings()` - 13 edges
5. `renderSkillPickerLines()` - 12 edges
6. `registerExtensionSettingCommand()` - 12 edges
7. `executeSshExec()` - 12 edges
8. `SettingsTable` - 11 edges
9. `ExtensionSettingsProvider` - 10 edges
10. `MaybePromise` - 10 edges

## Surprising Connections (you probably didn't know these)
- `safe path shortcuts` --semantically_similar_to--> `skill path expansion`  [INFERRED] [semantically similar]
  pi-inturl/README.md → pi-codex-dollar/README.md
- `pi-loadout integration` --conceptually_related_to--> `pi-loadout extension`  [INFERRED]
  pi-codex-dollar/README.md → pi-loadout/README.md
- `shared settings integration` --implements--> `shared extension settings core`  [EXTRACTED]
  pi-inturl/README.md → pi-extcore/README.md
- `SettingsFile` --references--> `SettingsState`  [EXTRACTED]
  packages/pi-extcore/src/settings/storage.ts → packages/pi-extcore/src/settings/types.ts
- `SharedSettingsFile` --references--> `SettingsState`  [EXTRACTED]
  packages/pi-extcore/src/settings/storage.ts → packages/pi-extcore/src/settings/types.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Shared extension settings architecture** — pi_extcore_readme_shared_extension_settings_core, pi_codex_dollar_readme_extension_settings, pi_inturl_readme_shared_settings_integration, pi_loadout_readme_pi_loadout_extension, pi_ssh_readme_shared_ssh_settings [EXTRACTED 1.00]
- **Input path and skill reference transforms** — pi_codex_dollar_readme_skill_path_expansion, pi_inturl_readme_safe_path_shortcuts, pi_inturl_readme_path_traversal_protection [INFERRED 0.85]

## Communities (12 total, 0 thin omitted)

### Community 0 - "Codex Skill Picker"
Cohesion: 0.07
Nodes (65): createSkillPickerEditor(), getPickerState(), HIGHLIGHT_BASE_EDITOR, HIGHLIGHT_WRAPPED, isEditorLike(), dollarSkillAutocomplete(), BranchEntry, loadoutActiveSkillNames() (+57 more)

### Community 1 - "SSH Session Management"
Cohesion: 0.05
Nodes (37): clampPositiveInt(), DEFAULT_MOUNT_DIR, DEFAULT_PLUGIN_DIR, envNumber(), envString(), HostFailureState, isMissingBinaryError(), MountProbe (+29 more)

### Community 2 - "SSH Tool Registration"
Cohesion: 0.05
Nodes (38): clampInt(), createManager(), createSshHostsPanel(), DEFAULT_SETTINGS, ensureTrailingSlash(), errorMessage(), errorResult(), formatDisplayPath() (+30 more)

### Community 3 - "Extcore TUI Components"
Cohesion: 0.07
Nodes (43): EditorComponent, EditorComponentFactory, EditorHostContext, EditorKeybindings, EditorModifier, EditorModifierContext, EditorTheme, EditorTui (+35 more)

### Community 4 - "Extcore Settings Providers"
Cohesion: 0.11
Nodes (42): piExtcore(), SettingsPanelHost, SettingsPanelInput, SettingsPanelPane, createGeneralPaneGroups(), createPaneState(), createProviderState(), loadProviderState() (+34 more)

### Community 5 - "Codex Interaction Tests"
Cohesion: 0.05
Nodes (35): ANSI_ESCAPE_PATTERN, backspaceEditor, baseEditor, baseEditorSymbol, createEditor(), defaultDollarSettings, editor, editorWithBaseMetadata (+27 more)

### Community 6 - "Loadout State UI"
Cohesion: 0.08
Nodes (34): DEFAULT_LOADOUT_SETTINGS, GLOBAL_LOADOUT_PATH, LOADOUT_SETTING_GROUPS, LoadoutDiff, loadoutExtension(), LoadoutLogDetails, LoadoutPresetName, LoadoutResult (+26 more)

### Community 7 - "Extcore Settings Panel"
Cohesion: 0.12
Nodes (28): createEmptyPane(), createGroupSettingItem(), createPlainSettingItems(), createSettingItems(), createSettingsPanelComponent(), formatFooter(), keycap(), resolveSettingDescription() (+20 more)

### Community 8 - "Package Architecture Docs"
Cohesion: 0.06
Nodes (36): ext-settings.json storage, extension settings, inline skill picker, pi-codex-dollar extension, pi-loadout integration, prompt highlighting, $skill-name autocomplete, skill ordering (+28 more)

### Community 9 - "Shared Settings Storage"
Cohesion: 0.13
Nodes (19): asSettingsState(), createAgentExtensionSettingsStorage(), createAgentJsonSettingsStorage(), createExtensionSettingsStorage(), createJsonSettingsStorage(), isNodeError(), isRecord(), isSettingsFile() (+11 more)

### Community 10 - "Inturl Path Shortcuts"
Cohesion: 0.20
Nodes (17): applyPathShortcutExpansion(), createPathShortcutToolPanel(), createPathShortcutToolPanelComponent(), DEFAULT_PATH_SHORTCUT_SETTINGS, enabledToolsFromState(), expandPathShortcut(), expandTmpPath(), parseToolNames() (+9 more)

### Community 11 - "Settings Table UI"
Cohesion: 0.22
Nodes (3): padRight(), SettingsTable, SettingsTableOptions

## Knowledge Gaps
- **126 isolated node(s):** `HIGHLIGHT_WRAPPED`, `HIGHLIGHT_BASE_EDITOR`, `LoadoutState`, `BranchEntry`, `EXTENSION_DIR` (+121 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `registerExtensionSettings()` connect `Extcore Settings Providers` to `Codex Skill Picker`, `SSH Tool Registration`, `Extcore TUI Components`, `Loadout State UI`, `Inturl Path Shortcuts`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **Why does `SessionManager` connect `SSH Session Management` to `SSH Tool Registration`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Why does `SettingsState` connect `Extcore Settings Providers` to `Codex Skill Picker`, `SSH Tool Registration`, `Extcore TUI Components`, `Loadout State UI`, `Extcore Settings Panel`, `Shared Settings Storage`, `Inturl Path Shortcuts`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **What connects `HIGHLIGHT_WRAPPED`, `HIGHLIGHT_BASE_EDITOR`, `LoadoutState` to the rest of the system?**
  _126 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Codex Skill Picker` be split into smaller, more focused modules?**
  _Cohesion score 0.06666666666666667 - nodes in this community are weakly interconnected._
- **Should `SSH Session Management` be split into smaller, more focused modules?**
  _Cohesion score 0.05472837022132797 - nodes in this community are weakly interconnected._
- **Should `SSH Tool Registration` be split into smaller, more focused modules?**
  _Cohesion score 0.05423728813559322 - nodes in this community are weakly interconnected._