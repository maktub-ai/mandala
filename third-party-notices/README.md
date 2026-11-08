# CodeGraph runtime notices

- `CodeGraph-1.2.0-LICENSE.txt` is the exact upstream MIT notice from `@colbymchenry/codegraph` tag `v1.2.0`, `LICENSE` (Copyright 2026 ColbyMchenry). Retrieved with `git show v1.2.0:LICENSE` from the verified upstream research checkout. SHA256: `e6d98f98c666bebe065ac2492a0a19232cc318d4d67bac3ca42ffb77bacc8809`.
- `Node-24.16.0-LICENSE.txt` is the complete official Node.js `v24.16.0` notice, including bundled dependency notices, for the additional Node binary retained in the CodeGraph platform package. Source: https://raw.githubusercontent.com/nodejs/node/v24.16.0/LICENSE . SHA256: `4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18`. The distribution LICENSE URL returned HTTP 404; the matching official Git tag supplied this exact-version notice.

The desktop build copies this directory to `runtime/third-party-notices/`. It retains the complete platform package and its dependency notices under `runtime/node_modules/@colbymchenry/codegraph-<platform>/`. The embedded SDK runs on Mandala's host Node 22; the extra Node 24 CLI binary is retained but is not launched by this integration. The host Node notice remains `runtime/LICENSE-node.txt` under the existing build rule.

## Voice runtime notices

- `whisper-node-addon-1.1.0-LICENSE.txt`: MIT notice from [Kutalia/whisper-node-addon](https://github.com/Kutalia/whisper-node-addon/blob/038bd87945eb08e80a81564d3390e617be8371cc/LICENSE), the npm 1.1.0 `gitHead`. SHA256: `bc782f4000dc5b9a8fad9fe647f7416fb0c1d19bfa661d6ce2bc6ee9b7073a0d`.
- `whisper.cpp-LICENSE.txt`: MIT notice for whisper.cpp and ggml from the addon's [pinned submodule](https://github.com/Kutalia/whisper.cpp/blob/c9eb98976aac43e76d396ca93a362153e0e33d29/LICENSE). SHA256: `e562a2ddfaf8280537795ac5ecd34e3012b6582a147ef69ba6a6a5c08c84757d`.
- `Whisper-LICENSE.txt`: MIT notice from [OpenAI Whisper v20250625](https://github.com/openai/whisper/blob/v20250625/LICENSE), included for the optional Whisper model downloads. SHA256: `b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d`.

Only the host platform's speech binaries are retained in desktop builds. On macOS their library references are made relative to the bundled directory and re-signed before application signing. Model weights are downloaded only on user request and are not bundled.
