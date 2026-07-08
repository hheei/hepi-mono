extension panel, controlled by Pi-setting
────────────────────────────────────────────────────────────────────────── <- Can be edited by Pi-status-bar
 Extension Panel: <prev-name> [<extension>] <next-name>
> type to search
 ▾ Extension       [2/3]        (↥)   fffind (tool)
   ○ pi-fff                           Origin: 
   ● pi-ggg                             <package:npm:@ff-labs/pi-fff>
 ▾ Tools           [1/3]              Status:
   ● bash          system               disabled (or active, inherit)
   ○ edit          system             Description:
→  ○ fffind        extension            search for files and directories
 ▾ Skills          [3/3]                in a project using fffind.
   ● skill-a       system       
   ● skill-b       user         
   ● skill-c       project      
 ▸ MCP             [1/3]
 ▾ Commands        [1/2]        
   ● command-a     system       
   ● command-b     user         
 ▾ hooks           [2/2]        
   ● hook-a        user         
   ● hook-b        user         (↧)
 
Tab: switch · Space: toggle · Esc: close
────────────────────────────────────────────────────────────────────────── <- Can be edited by Pi-status-bar
>

1. this module act as shared tui panel for all registered extensions setting panel.
2. switch means switch to the next extension (shift+tab to switch to the previous extension).
3. Only registered extensions will be shown and can be switched to. If the extension is not registered, it will not be shown in the list.
4. The abstraction of this extension is to provide a tui panel with predefined: search-bar (can be turn off), predesigned setting layout (can use custom layout), and keymap bar (can be turn off).

For search-bar: showSearchBar = true/false, for keymap: showKeymap, and keyMapItems = [{key, description}, ...] (will not bind for you)

Pi-loadout rewrite (need pi-extension-setting)
────────────────────────────────────────────────────────────────────────── <- Can be edited by Pi-status-bar
 Extension Panel: <prev-name> [pi-loadout] <next-name>
> type to search
 ▾ Extension       [2/3]        (↥)   fffind (tool)
   ○ pi-fff                           Origin: 
   ● pi-ggg                             <package:npm:@ff-labs/pi-fff>
 ▾ Tools           [1/3]              Status:
   ● bash          system               disabled (or active, inherit)
   ○ edit          system             Description:
→  ○ fffind        extension            search for files and directories
 ▾ Skills          [3/3]                in a project using fffind.
   ● skill-a       system       
   ● skill-b       user         
   ● skill-c       project      
 ▸ MCP             [1/3]
 ▾ Commands        [1/2]        
   ● command-a     system       
   ● command-b     user         
 ▾ hooks           [2/2]        
   ● hook-a        user         
   ● hook-b        user         (↧)
 
Tab: switch · Space: toggle · Esc: close
────────────────────────────────────────────────────────────────────────── <- Can be edited by Pi-status-bar

1. dim color: package, disabled, search, [pi-loadout]
2. accent color: active, focus line, Extension Pannel, Space, Esc
3. default color: any non-focused items, Description, Status, Origin
4. There are enabledExtensions, diabledExtensions in `~/.pi/agent/setting.json` or `.pi/setting.json`
5. inherit: inherit from global (~/.pi/agent/setting.json)
6. Origin for extension: <package:npm:@ff-labs/pi-fff>, for tools: <package:npm:@ff-labs/pi-fff>, for skills: <package:npm:@ff-labs/pi-fff> or `<path-of-skill.md>, for commands ...
7. eanbledExtensions for global config `~/.pi/agent/setting.json` will not be used. project diable > project enable > global diable
8. example of enabled/diabled Extensions in `~/.pi/agent/setting.json` or `.pi/setting.json`:
   {
     "enabledExtensions": [
       "extension:pi-fff",
       "extension:pi-ggg"
     ],
     "disabledExtensions": [
       "extension:pi-fff",
       "skill:skill-a",
       "tool:edit",
       "hook:hook-a",
       "command:command-a"
     ]
   }
   for mcp, they are stored in `~/.pi/agent/mcp.json` or `.pi/mcp.json` with keys `disabledServers` and `enabledServers`, `mcp:`prefix is not ALLOWED and no needed.
9. ↧ and ↥ are shown depending on the number of items in the list. If there are more items than the visible area, the arrow will be shown. If all items are visible, the arrow will not be shown (or at start or end of the list).
10. Toggle for a group means collapse/expand the group. If the group is collapsed, the items in the group will not be shown. If the group is expanded, the items in the group will be shown.
11. search will automatically filter out all group titles and also show the items in the collapsed groups. If the search result is empty, it will show "No results found". If the search result is not empty, it will show the items in the search result.
12. Use /extension:loadout to open the loadout panel or if the user installed the pi-extension-setting, the loadout panel can be opened from /extension command
13. If the skill/command/hook providing extension is diabled, they will not be shown in the list.

Pi-common (modified from oh-my-pi)
Original:
──────────────────────────────────────────────────────────────────────────
PROMPT HERE
──────────────────────────────────────────────────────────────────────────
New:

REPLY1
⤵ 2.4K  ⤴ 413  © 58K  ⏱ 4.3s  ⚡ 50.0/s

REPLY2
⤵ 2.4K  ⤴ 413  © 58K  ⏱ 4.3s  ⚡ 50.0/s

── π · <Title> ───────────────────────────────────────────────────────────
PROMPT HERE
── 📂 .../WORKING-DIR ───────── ... ──── PROVIDER/MODEL ◒ · ◫ 6.6%/272K ──

1. ⤵ input token
2. ⤴ output token
3. © cached token
4. ⏱ time taken for the request
5. ⚡ token per second
6. Title is auto generated from selected model and provider, can be edited by user in `~/.pi/agent/setting.json` or `.pi/setting.json` with key `autoTitle = True/False`. If False, before the user names the section, the title will not be shown. `autoTitleModel = <provider>/<model>` can be set to auto generate title for specific provider and model. If not set, the default title will be generated for all provider and model.
7. thinking level ○/●/◒, depending of the thinking level of the model. (○: low..., ●: high/max..., ◒: medium...)