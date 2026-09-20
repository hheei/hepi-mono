# @hheei/pi-settings

Settings-surface host and Loadout policy owner for HEPI Pi extensions. Its
`@hheei/pi-ext-core` production dependency is installed automatically; install settings-provider
extensions such as `@hheei/pi-ext-tools` separately as needed.

Run `/ext-settings` or `/loadout` in Pi TUI mode. The package hosts registered settings pages, owns
tool/skill/resource activation policy, and temporarily suspends core-managed editor widgets while the
surface is open.

Extension configuration is stored separately from Pi host configuration: global values use
`<agentDir>/ext_settings.json`, project overrides use `<cwd>/.pi/ext_settings.json`, and each provider
registers globally unique top-level group IDs. Duplicate group IDs fail during registration.
