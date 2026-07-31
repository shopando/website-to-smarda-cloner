# Smarda Markup – Syntax (Teilmenge für den Downloader)

Eine Seite ist ein Array von Knoten. Jeder Knoten hat ein `component`-Feld mit
Prefix, das Typ und HTML-Tag festlegt:

- **`box:<tag>`** – strukturelles Element (`div`, `section`, `ul`, `li`, `a`,
  `button`, …). Darf beliebige Kind-Knoten enthalten, nie eigenen Text.
- **`text:<tag>`** – Text-Container (`p`, `h1`–`h6`, `span`, `li`, …). Enthält
  entweder `content` (fertiges HTML, nur Zeilenumbrüche + wenige Entities)
  ODER `children` aus `text_segment:`-Knoten – nie beides.
- **`text_segment:<tag>`** – Inline-Formatierung innerhalb eines
  `text:`-Knotens (`a`, `strong`, `em`, `span`, …). `text_segment:plain` ist
  reiner Text (nur `content`, keine Kinder, kein Style).

Nicht Teil dieser Syntax-Teilmenge (werden vom Downloader ignoriert):
`system:`-Komponenten, `presetGroup`, sowie `data` – mit Ausnahme von
`linkedUrl` (Link-Ziel) und `target` bei Links.

## Style

`style` hat die Form `Breakpoint → State → CSS-Eigenschaften` (camelCase):

```json
{
  "default": {
    "initial": { "color": "#333333", "fontSize": "1rem" },
    "hover": { "color": "#000000" }
  },
  "max:767px": { "initial": { "fontSize": "0.875rem" } }
}
```

- `default` gilt immer, ohne Media-Query.
- Weitere Keys sind eigene Breakpoints: `min:<px>`, `max:<px>` oder
  `min:<px>|max:<px>`.
- States: `initial`, `hover`, `focus`, `active`, `visited`, `first-child`,
  `last-child`.
- Der Downloader erzeugt aktuell nur `default.initial`.

## Links

`href` → `data.linkedUrl`, `target="_blank"` → `data.target`. Gilt für
`box:a` und `text_segment:a`.

## Beispiel

```json
[
  {
    "component": "box:div",
    "style": {
      "default": {
        "initial": { "display": "flex", "flexDirection": "column", "padding": "2rem" }
      }
    },
    "children": [
      {
        "component": "text:h1",
        "content": "Willkommen"
      },
      {
        "component": "text:p",
        "children": [
          { "component": "text_segment:plain", "content": "Mehr dazu " },
          {
            "component": "text_segment:a",
            "content": "hier",
            "data": { "linkedUrl": "/ueber-uns", "target": "_blank" }
          }
        ]
      },
      {
        "component": "box:a",
        "data": { "linkedUrl": "https://example.com" },
        "style": {
          "default": {
            "initial": {
              "display": "inline-block",
              "padding": "0.75rem 1.5rem",
              "background": "#4a9eff",
              "color": "#ffffff"
            }
          }
        },
        "children": [
          { "component": "text:span", "content": "Jetzt entdecken" }
        ]
      }
    ]
  }
]
```
