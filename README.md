# chatbridge-cli

A reusable OSS framework for using web-based chat AI services from the command line, without touching the browser UI.

Service-specific behaviour (URLs, DOM selectors, login flows, response detection) is isolated behind a Provider / Adapter interface, so the same core can drive multiple web chat AI services.

## Status

Early design stage. No implementation yet.

## Planned features

- Interactive TUI, in the style of Claude Code
- Non-interactive one-shot execution (`-p "..."`) writing to stdout
- Playwright-based browser automation runtime
- Browser session and authentication-state management (save / restore / clear)
- A Provider API for plugging in service-specific implementations

## Concept

```
CLI ─┬─ Interactive Mode (TUI)
     └─ One-shot Mode (stdout)
              │
            Core
              │
         Provider API
              │
       Playwright Layer
              │
         Web Chat AI
```

The core and providers do not depend on the TUI, so both execution modes share the same code paths.

## Authentication

The framework never stores usernames or passwords. You log in yourself in a headful browser, and the resulting browser authentication state is saved and reused on subsequent runs.

## License

TBD
