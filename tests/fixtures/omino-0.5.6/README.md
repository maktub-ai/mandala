# Native Omino plan fixture

`todo-app.html.gz` and `todo-app.summary.json` are outputs of Omino 0.5.6's `renderHtml` and `planSummary` for its fictional Chinese `examples/todo-app`. The compressed HTML retains Omino's graph, board, list, decisions, styles and scripts. The renderer ran once in an isolated fixture home with project ID `todo-app`, Git discovery disabled and a fixed dummy probe on port 18331. The browser test intercepts that probe. Mandala only decompresses the fixture during test setup. Omino's MIT license is included beside it.
