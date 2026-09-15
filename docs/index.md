# datasette-paper

[← datasette-paper home](https://datasette.github.io/datasette-paper/)

Collaborative document editor for Datasette. ProseMirror frontend, SQLite-backed
storage in Datasette's internal database, real-time collaboration over SSE.

![The paper editor: a rich-text document with headings, a table and a task list, a formatting toolbar, and a header showing the author, edit time and number of users online.](screenshots/editor.png)

Rich text with tables and task lists, wiki-style links between papers, images,
inline `#tags`, `@mentions`, live SQL sources and values, and per-paper
sharing — see [Getting started](getting-started.md) to try it, or
[Installation](installation.md) to add it to your own Datasette instance.

```{toctree}
:maxdepth: 1
:caption: Writing papers

getting-started
editor
slash-menu
links-mentions-tags
embeds
sources-and-values
sharing
keyboard-shortcuts
```

```{toctree}
:maxdepth: 1
:caption: Running the plugin

installation
configuration
cli
papers-as-data
api
permissions/index
```

```{toctree}
:maxdepth: 1
:caption: Extending

custom-embeds
```

```{toctree}
:maxdepth: 1
:caption: Project

changelog
```
