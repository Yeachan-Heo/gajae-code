    (function() {
      'use strict';

      // ============================================================
      // DATA LOADING
      // ============================================================

      const base64 = document.getElementById('session-data').textContent;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      const { header, entries, leafId: defaultLeafId, systemPrompt, tools } = data;

      // ============================================================
      // URL PARAMETER HANDLING
      // ============================================================

      // Parse URL parameters for deep linking: leafId and targetId
      // Check for injected params (when loaded in iframe via srcdoc) or use window.location
      const injectedParams =
        document.querySelector('meta[name="gjc-url-params"]') ||
        document.querySelector('meta[name="pi-url-params"]');
      const searchString = injectedParams ? injectedParams.content : window.location.search.substring(1);
      const urlParams = new URLSearchParams(searchString);
      const urlLeafId = urlParams.get('leafId');
      const urlTargetId = urlParams.get('targetId');
      // Use URL leafId if provided, otherwise fall back to session default
      const leafId = urlLeafId || defaultLeafId;

      // ============================================================
      // DATA STRUCTURES
      // ============================================================

      // Entry lookup by ID
      const byId = new Map();
      for (const entry of entries) {
        byId.set(entry.id, entry);
      }

      // Tool call lookup (toolCallId -> {name, arguments})
      const toolCallMap = new Map();
      for (const entry of entries) {
        if (entry.type === 'message' && entry.message.role === 'assistant') {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'toolCall') {
                toolCallMap.set(block.id, { name: block.name, arguments: block.arguments });
              }
            }
          }
        }
      }

      // Label lookup (entryId -> label string)
      // Labels are stored in 'label' entries that reference their target via targetId
      const labelMap = new Map();
      for (const entry of entries) {
        if (entry.type === 'label' && entry.targetId && entry.label) {
          labelMap.set(entry.targetId, entry.label);
        }
      }

      // ============================================================
      // TREE DATA PREPARATION (no DOM, pure data)
      // ============================================================

      /**
       * Build tree structure from flat entries.
       * Returns array of root nodes, each with { entry, children, label }.
       */
      function buildTree() {
        const nodeMap = new Map();
        const roots = [];

        // Create nodes
        for (const entry of entries) {
          nodeMap.set(entry.id, { 
            entry, 
            children: [],
            label: labelMap.get(entry.id)
          });
        }

        // Build parent-child relationships
        for (const entry of entries) {
          const node = nodeMap.get(entry.id);
          if (entry.parentId === null || entry.parentId === undefined || entry.parentId === entry.id) {
            roots.push(node);
          } else {
            const parent = nodeMap.get(entry.parentId);
            if (parent) {
              parent.children.push(node);
            } else {
              roots.push(node);
            }
          }
        }

        // Sort children by timestamp
        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }
        roots.forEach(sortChildren);

        return roots;
      }

      /**
       * Build set of entry IDs on path from root to target.
       */
      function buildActivePathIds(targetId) {
        const ids = new Set();
        let current = byId.get(targetId);
        while (current) {
          ids.add(current.id);
          // Stop if no parent or self-referencing (root)
          if (!current.parentId || current.parentId === current.id) {
            break;
          }
          current = byId.get(current.parentId);
        }
        return ids;
      }

      /**
       * Get array of entries from root to target (the conversation path).
       */
      function getPath(targetId) {
        const path = [];
        let current = byId.get(targetId);
        while (current) {
          path.unshift(current);
          // Stop if no parent or self-referencing (root)
          if (!current.parentId || current.parentId === current.id) {
            break;
          }
          current = byId.get(current.parentId);
        }
        return path;
      }

      /**
       * Flatten tree into list with indentation and connector info.
       * Returns array of { node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots }.
       * Matches tree-selector.ts logic exactly.
       */
      function flattenTree(roots, activePathIds) {
        const result = [];
        const multipleRoots = roots.length > 1;

        // Mark which subtrees contain the active leaf
        const containsActive = new Map();
        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }
        roots.forEach(markActive);

        // Stack: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
        const stack = [];

        // Add roots (prioritize branch containing active leaf)
        const orderedRoots = [...roots].sort((a, b) => 
          Number(containsActive.get(b)) - Number(containsActive.get(a))
        );
        for (let i = orderedRoots.length - 1; i >= 0; i--) {
          const isLast = i === orderedRoots.length - 1;
          stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
        }

        while (stack.length > 0) {
          const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();

          result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots });

          const children = node.children;
          const multipleChildren = children.length > 1;

          // Order children (active branch first)
          const orderedChildren = [...children].sort((a, b) => 
            Number(containsActive.get(b)) - Number(containsActive.get(a))
          );

          // Calculate child indent (matches tree-selector.ts)
          let childIndent;
          if (multipleChildren) {
            // Parent branches: children get +1
            childIndent = indent + 1;
          } else if (justBranched && indent > 0) {
            // First generation after a branch: +1 for visual grouping
            childIndent = indent + 1;
          } else {
            // Single-child chain: stay flat
            childIndent = indent;
          }

          // Build gutters for children
          const connectorDisplayed = showConnector && !isVirtualRootChild;
          const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
          const connectorPosition = Math.max(0, currentDisplayIndent - 1);
          const childGutters = connectorDisplayed
            ? [...gutters, { position: connectorPosition, show: !isLast }]
            : gutters;

          // Add children in reverse order for stack
          for (let i = orderedChildren.length - 1; i >= 0; i--) {
            const childIsLast = i === orderedChildren.length - 1;
            stack.push([orderedChildren[i], childIndent, multipleChildren, multipleChildren, childIsLast, childGutters, false]);
          }
        }

        return result;
      }

      /**
       * Build ASCII prefix string for tree node.
       */
      function buildTreePrefix(flatNode) {
        const { indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots } = flatNode;
        const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
        const connector = showConnector && !isVirtualRootChild ? (isLast ? '└─ ' : '├─ ') : '';
        const connectorPosition = connector ? displayIndent - 1 : -1;

        const totalChars = displayIndent * 3;
        const prefixChars = [];
        for (let i = 0; i < totalChars; i++) {
          const level = Math.floor(i / 3);
          const posInLevel = i % 3;

          const gutter = gutters.find(g => g.position === level);
          if (gutter) {
            prefixChars.push(posInLevel === 0 ? (gutter.show ? '│' : ' ') : ' ');
          } else if (connector && level === connectorPosition) {
            if (posInLevel === 0) {
              prefixChars.push(isLast ? '└' : '├');
            } else if (posInLevel === 1) {
              prefixChars.push('─');
            } else {
              prefixChars.push(' ');
            }
          } else {
            prefixChars.push(' ');
          }
        }
        return prefixChars.join('');
      }

      // ============================================================
      // FILTERING (pure data)
      // ============================================================

      let filterMode = 'default';
      let searchQuery = '';

      function hasTextContent(content) {
        if (typeof content === 'string') return content.trim().length > 0;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'text' && c.text && c.text.trim().length > 0) return true;
          }
        }
        return false;
      }

      function extractContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join('');
        }
        return '';
      }

      function getSearchableText(entry, label) {
        const parts = [];
        if (label) parts.push(label);

        switch (entry.type) {
          case 'message': {
            const msg = entry.message;
            parts.push(msg.role);
            if (msg.content) parts.push(extractContent(msg.content));
            if (msg.role === 'bashExecution' && msg.command) parts.push(msg.command);
            if (msg.role === 'jsExecution' && msg.code) parts.push(msg.code);
            break;
          }
          case 'custom_message':
            parts.push(entry.customType);
            parts.push(typeof entry.content === 'string' ? entry.content : extractContent(entry.content));
            break;
          case 'compaction':
            parts.push('compaction');
            break;
          case 'branch_summary':
            parts.push('branch summary', entry.summary);
            break;
          case 'model_change':
            parts.push('model', entry.model);
            break;
          case 'thinking_level_change':
            parts.push('thinking', entry.thinkingLevel);
            break;
          case 'mode_change':
            parts.push('mode', entry.mode);
            break;
        }

        return parts.join(' ').toLowerCase();
      }

      /**
       * Filter flat nodes based on current filterMode and searchQuery.
       */
      function filterNodes(flatNodes, currentLeafId) {
        const searchTokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

        return flatNodes.filter(flatNode => {
          const entry = flatNode.node.entry;
          const label = flatNode.node.label;
          const isCurrentLeaf = entry.id === currentLeafId;

          // Always show current leaf
          if (isCurrentLeaf) return true;

          // Hide assistant messages with only tool calls (no text) unless error/aborted
          if (entry.type === 'message' && entry.message.role === 'assistant') {
            const msg = entry.message;
            const hasText = hasTextContent(msg.content);
            const isErrorOrAborted = msg.stopReason && msg.stopReason !== 'stop' && msg.stopReason !== 'toolUse';
            if (!hasText && !isErrorOrAborted) return false;
          }

          // Apply filter mode
          const isSettingsEntry = ['label', 'custom', 'model_change', 'thinking_level_change', 'mode_change', 'ttsr_injection', 'session_init'].includes(entry.type);
          let passesFilter = true;

          switch (filterMode) {
            case 'user-only':
              passesFilter = entry.type === 'message' && entry.message.role === 'user';
              break;
            case 'no-tools':
              passesFilter = !isSettingsEntry && !(entry.type === 'message' && entry.message.role === 'toolResult');
              break;
            case 'labeled-only':
              passesFilter = label !== undefined;
              break;
            case 'all':
              passesFilter = true;
              break;
            default: // 'default'
              passesFilter = !isSettingsEntry;
              break;
          }

          if (!passesFilter) return false;

          // Apply search filter
          if (searchTokens.length > 0) {
            const nodeText = getSearchableText(entry, label);
            if (!searchTokens.every(t => nodeText.includes(t))) return false;
          }

          return true;
        });
      }

      // ============================================================
      // TREE DISPLAY TEXT (pure data -> string)
      // ============================================================

      function shortenPath(p) {
        if (typeof p !== 'string') return '';
        if (p.startsWith('/Users/')) {
          const parts = p.split('/');
          if (parts.length > 2) return '~' + p.slice(('/Users/' + parts[2]).length);
        }
        if (p.startsWith('/home/')) {
          const parts = p.split('/');
          if (parts.length > 2) return '~' + p.slice(('/home/' + parts[2]).length);
        }
        return p;
      }

      function formatToolCall(name, args) {
        switch (name) {
          case 'read': {
            const path = shortenPath(String(args.path || args.file_path || ''));
            const offset = args.offset;
            const limit = args.limit;
            let display = path;
            if (offset !== undefined || limit !== undefined) {
              const start = offset ?? 1;
              const end = limit !== undefined ? start + limit - 1 : '';
              display += `:${start}${end ? `-${end}` : ''}`;
            }
            return `[read: ${display}]`;
          }
          case 'write':
            return `[write: ${shortenPath(String(args.path || args.file_path || ''))}]`;
          case 'edit':
            return `[edit: ${shortenPath(String(args.path || args.file_path || ''))}]`;
          case 'bash': {
            const rawCmd = String(args.command || '');
            const cmd = rawCmd.replace(/[\n\t]/g, ' ').trim().slice(0, 50);
            return `[bash: ${cmd}${rawCmd.length > 50 ? '...' : ''}]`;
          }
          case 'grep':
            return `[grep: /${args.pattern || ''}/ in ${shortenPath(String((args.paths || [args.path || '.']).join(', ')))}]`;
          case 'find':
            return `[find: ${shortenPath(String((args.paths || [args.pattern || '.']).join(', ')))}]`;
          case 'ls':
            return `[ls: ${shortenPath(String(args.path || '.'))}]`;
          default: {
            const argsStr = JSON.stringify(args).slice(0, 40);
            return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? '...' : ''}]`;
          }
        }
      }

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      function escapeHtmlAttribute(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      const SUPPORTED_DATA_IMAGE_MIME_TYPES = new Set([
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
      ]);
      const STRICT_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

      function isStrictBase64(value) {
        if (value.length === 0 || !STRICT_BASE64_PATTERN.test(value)) return false;
        try {
          return btoa(atob(value)) === value;
        } catch {
          return false;
        }
      }

      function renderDataImage(image, className) {
        if (!image || typeof image.mimeType !== 'string' || typeof image.data !== 'string') return '';
        if (!SUPPORTED_DATA_IMAGE_MIME_TYPES.has(image.mimeType)) return '';
        if (!isStrictBase64(image.data)) return '';
        return `<img src="data:${escapeHtmlAttribute(image.mimeType)};base64,${escapeHtmlAttribute(image.data)}" class="${escapeHtmlAttribute(className)}" />`;
      }

      /**
       * Truncate string to maxLen chars, append "..." if truncated.
       */
      function truncate(s, maxLen = 100) {
        if (s.length <= maxLen) return s;
        return s.slice(0, maxLen) + '...';
      }

      /**
       * Get display text for tree node (returns HTML string).
       */
      function getTreeNodeDisplayHtml(entry, label) {
        const normalize = s => s.replace(/[\n\t]/g, ' ').trim();
        const labelHtml = label ? `<span class="tree-label">[${escapeHtml(label)}]</span> ` : '';

        switch (entry.type) {
          case 'message': {
            const msg = entry.message;
            if (msg.role === 'user') {
              const content = truncate(normalize(extractContent(msg.content)));
              return labelHtml + `<span class="tree-role-user">user:</span> ${escapeHtml(content)}`;
            }
            if (msg.role === 'developer') {
              const content = truncate(normalize(extractContent(msg.content)));
              return labelHtml + `<span class="tree-role-developer">developer:</span> ${escapeHtml(content)}`;
            }
            if (msg.role === 'assistant') {
              const textContent = truncate(normalize(extractContent(msg.content)));
              if (textContent) {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> ${escapeHtml(textContent)}`;
              }
              if (msg.stopReason === 'aborted') {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(aborted)</span>`;
              }
              if (msg.errorMessage) {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-error">${escapeHtml(truncate(msg.errorMessage))}</span>`;
              }
              return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(no text)</span>`;
            }
            if (msg.role === 'toolResult') {
              const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : null;
              if (toolCall) {
                return labelHtml + `<span class="tree-role-tool">${escapeHtml(formatToolCall(toolCall.name, toolCall.arguments))}</span>`;
              }
              return labelHtml + `<span class="tree-role-tool">[${escapeHtml(msg.toolName || 'tool')}]</span>`;
            }
            if (msg.role === 'bashExecution') {
              const cmd = truncate(normalize(msg.command || ''));
              return labelHtml + `<span class="tree-role-tool">[bash]:</span> ${escapeHtml(cmd)}`;
            }
            if (msg.role === 'jsExecution') {
              const code = truncate(normalize(msg.code || ''));
              return labelHtml + `<span class="tree-role-tool">[js]:</span> ${escapeHtml(code)}`;
            }
            return labelHtml + `<span class="tree-muted">[${escapeHtml(msg.role)}]</span>`;
          }
          case 'compaction':
            return labelHtml + `<span class="tree-compaction">[compaction: ${Math.round(entry.tokensBefore/1000)}k tokens]</span>`;
          case 'branch_summary': {
            const summary = truncate(normalize(entry.summary || ''));
            return labelHtml + `<span class="tree-branch-summary">[branch summary]:</span> ${escapeHtml(summary)}`;
          }
          case 'custom_message': {
            const content = typeof entry.content === 'string' ? entry.content : extractContent(entry.content);
            return labelHtml + `<span class="tree-custom">[${escapeHtml(entry.customType)}]:</span> ${escapeHtml(truncate(normalize(content)))}`;
          }
          case 'model_change':
            return labelHtml + `<span class="tree-muted">[model: ${escapeHtml(entry.model)}]</span>`;
          case 'thinking_level_change':
            return labelHtml + `<span class="tree-muted">[thinking: ${escapeHtml(entry.thinkingLevel)}]</span>`;
          case 'mode_change':
            return labelHtml + `<span class="tree-muted">[mode: ${escapeHtml(entry.mode)}]</span>`;
          default:
            return labelHtml + `<span class="tree-muted">[${escapeHtml(entry.type)}]</span>`;
        }
      }

      // ============================================================
      // TREE RENDERING (DOM manipulation)
      // ============================================================

      let currentLeafId = leafId;
      let currentTargetId = urlTargetId || leafId;
      let treeRendered = false;

      function renderTree() {
        const tree = buildTree();
        const activePathIds = buildActivePathIds(currentLeafId);
        const flatNodes = flattenTree(tree, activePathIds);
        const filtered = filterNodes(flatNodes, currentLeafId);
        const container = document.getElementById('tree-container');

        // Full render only on first call or when filter/search changes
        if (!treeRendered) {
          container.innerHTML = '';

          for (const flatNode of filtered) {
            const entry = flatNode.node.entry;
            const isOnPath = activePathIds.has(entry.id);
            const isTarget = entry.id === currentTargetId;

            const div = document.createElement('div');
            div.className = 'tree-node';
            if (isOnPath) div.classList.add('in-path');
            if (isTarget) div.classList.add('active');
            div.dataset.id = entry.id;

            const prefix = buildTreePrefix(flatNode);
            const prefixSpan = document.createElement('span');
            prefixSpan.className = 'tree-prefix';
            prefixSpan.textContent = prefix;

            const marker = document.createElement('span');
            marker.className = 'tree-marker';
            marker.textContent = isOnPath ? '•' : ' ';

            const content = document.createElement('span');
            content.className = 'tree-content';
            content.innerHTML = getTreeNodeDisplayHtml(entry, flatNode.node.label);

            div.appendChild(prefixSpan);
            div.appendChild(marker);
            div.appendChild(content);
            div.addEventListener('click', () => navigateTo(entry.id));

            container.appendChild(div);
          }

          treeRendered = true;
        } else {
          // Just update markers and classes
          const nodes = container.querySelectorAll('.tree-node');
          for (const node of nodes) {
            const id = node.dataset.id;
            const isOnPath = activePathIds.has(id);
            const isTarget = id === currentTargetId;

            node.classList.toggle('in-path', isOnPath);
            node.classList.toggle('active', isTarget);

            const marker = node.querySelector('.tree-marker');
            if (marker) {
              marker.textContent = isOnPath ? '•' : ' ';
            }
          }
        }

        document.getElementById('tree-status').textContent = `${filtered.length} / ${flatNodes.length} entries`;

        // Scroll active node into view after layout
        setTimeout(() => {
          const activeNode = container.querySelector('.tree-node.active');
          if (activeNode) {
            activeNode.scrollIntoView({ block: 'nearest' });
          }
        }, 0);
      }

      function forceTreeRerender() {
        treeRendered = false;
        renderTree();
      }

      // ============================================================
      // MESSAGE RENDERING
      // ============================================================

      function formatTokens(count) {
        if (count < 1000) return count.toString();
        if (count < 10000) return (count / 1000).toFixed(1) + 'k';
        if (count < 1000000) return Math.round(count / 1000) + 'k';
        return (count / 1000000).toFixed(1) + 'M';
      }

      function formatTimestamp(ts) {
        if (!ts) return '';
        const date = new Date(ts);
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      function replaceTabs(text) {
        return text.replace(/\t/g, '   ');
      }

      /** Safely coerce value to string for display. Returns null if invalid type. */
      function str(value) {
        if (typeof value === 'string') return value;
        if (value == null) return '';
        return null;
      }

      function getLanguageFromPath(filePath) {
        const ext = filePath.split('.').pop()?.toLowerCase();
        const extToLang = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
          c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
          php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
          sql: 'sql', html: 'html', css: 'css', scss: 'scss',
          json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
          md: 'markdown', dockerfile: 'dockerfile'
        };
        return extToLang[ext];
      }

      function findToolResult(toolCallId) {
        for (const entry of entries) {
          if (entry.type === 'message' && entry.message.role === 'toolResult') {
            if (entry.message.toolCallId === toolCallId) {
              return entry.message;
            }
          }
        }
        return null;
      }

      function formatExpandableOutput(text, maxLines, lang) {
        text = replaceTabs(text);
        const lines = text.split('\n');
        const displayLines = lines.slice(0, maxLines);
        const remaining = lines.length - maxLines;

        if (lang) {
          let highlighted;
          try {
            highlighted = hljs.highlight(text, { language: lang }).value;
          } catch {
            highlighted = escapeHtml(text);
          }

          if (remaining > 0) {
            const previewCode = displayLines.join('\n');
            let previewHighlighted;
            try {
              previewHighlighted = hljs.highlight(previewCode, { language: lang }).value;
            } catch {
              previewHighlighted = escapeHtml(previewCode);
            }

            return `<div class="tool-output expandable" onclick="this.classList.toggle('expanded')">
              <div class="output-preview"><pre><code class="hljs">${previewHighlighted}</code></pre>
              <div class="expand-hint">... (${remaining} more lines)</div></div>
              <div class="output-full"><pre><code class="hljs">${highlighted}</code></pre></div></div>`;
          }

          return `<div class="tool-output"><pre><code class="hljs">${highlighted}</code></pre></div>`;
        }

        // Plain text output
        if (remaining > 0) {
          let out = '<div class="tool-output expandable" onclick="this.classList.toggle(\'expanded\')">';
          out += '<div class="output-preview">';
          for (const line of displayLines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
          }
          out += `<div class="expand-hint">... (${remaining} more lines)</div></div>`;
          out += '<div class="output-full">';
          for (const line of lines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
          }
          out += '</div></div>';
          return out;
        }

        let out = '<div class="tool-output">';
        for (const line of displayLines) {
          out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
        }
        out += '</div>';
        return out;
      }

      // ============================================================
      // TOOL CALL RENDERING
      // ============================================================

      // Shared helpers for per-tool renderers.
      function toolHead(label, pathHtml, badges) {
        let html = '<div class="tool-header"><span class="tool-name">' + escapeHtml(label) + '</span>';
        if (pathHtml) html += ' <span class="tool-path">' + pathHtml + '</span>';
        if (badges) {
          for (const badge of badges) {
            if (badge != null && badge !== '') {
              html += ' <span class="tool-badge">' + escapeHtml(String(badge)) + '</span>';
            }
          }
        }
        html += '</div>';
        return html;
      }

      function invalidArgHtml() {
        return '<span class="tool-error">[invalid arg]</span>';
      }

      function pathDisplay(filePath, offset, limit) {
        if (filePath == null) return invalidArgHtml();
        let html = escapeHtml(shortenPath(filePath || ''));
        if (offset !== undefined || limit !== undefined) {
          const start = offset == null ? 1 : offset;
          const end = limit !== undefined ? start + limit - 1 : '';
          html += '<span class="line-numbers">:' + start + (end ? '-' + end : '') + '</span>';
        }
        return html;
      }

      function codeBlock(code, lang) {
        if (code == null || code === '') return '';
        const text = String(code);
        let highlighted;
        try {
          highlighted = lang ? hljs.highlight(text, { language: lang }).value : escapeHtml(text);
        } catch {
          highlighted = escapeHtml(text);
        }
        return '<div class="tool-output"><pre><code class="hljs">' + highlighted + '</code></pre></div>';
      }

      // Per-tool renderers. Each accepts (name, args, result, ctx) and returns the inner HTML.
      function renderBash(name, args, result, ctx) {
        const command = str(args.command);
        const cwd = str(args.cwd);
        const env = args.env && typeof args.env === 'object' ? args.env : null;
        const cmdDisplay = command === null ? invalidArgHtml() : escapeHtml(command || '...');
        let prefix = '';
        if (env) {
          for (const [k, v] of Object.entries(env)) {
            prefix += escapeHtml(k) + '=' + escapeHtml(String(v)) + ' ';
          }
        }
        let html = '<div class="tool-command">$ ' + prefix + cmdDisplay + '</div>';
        const badges = [];
        if (cwd) badges.push('cwd=' + shortenPath(cwd));
        if (args.timeout) badges.push('timeout=' + args.timeout + 's');
        if (args.pty) badges.push('pty');
        if (args.head) badges.push('head=' + args.head);
        if (args.tail) badges.push('tail=' + args.tail);
        if (badges.length) {
          html += '<div class="tool-meta">' + badges.map(b => '<span class="tool-badge">' + escapeHtml(b) + '</span>').join(' ') + '</div>';
        }
        if (result) {
          html += ctx.renderResultImages();
          const output = ctx.getResultText().trim();
          if (output) html += formatExpandableOutput(output, 5);
        }
        return html;
      }

      function renderJsLike(name, args, result, ctx) {
        let html = toolHead(name, '');
        const cells = result && result.details && Array.isArray(result.details.cells) ? result.details.cells : null;
        if (cells) {
          for (const cell of cells) {
            html += '<div class="tool-cell">';
            if (cell && cell.title) html += '<div class="tool-cell-title">' + escapeHtml(String(cell.title)) + '</div>';
            const code = cell && typeof cell.code === 'string' ? cell.code : '';
            const lang = cell && cell.language === 'js' ? 'javascript' : 'python';
            html += codeBlock(code, lang);
            html += '</div>';
          }
        } else if (typeof args.input === 'string') {
          html += codeBlock(args.input, null);
        } else {
          html += '<div class="tool-error">[missing input]</div>';
        }
        if (result) {
          html += ctx.renderResultImages();
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 10);
        }
        return html;
      }

      function renderRead(name, args, result, ctx) {
        const filePath = str(args.file_path == null ? args.path : args.file_path);
        let pathHtml = pathDisplay(filePath, args.offset, args.limit);
        if (args.sel) pathHtml += '<span class="line-numbers">:' + escapeHtml(String(args.sel)) + '</span>';
        let html = toolHead('read', pathHtml);
        if (result) {
          html += ctx.renderResultImages();
          const output = ctx.getResultText();
          const lang = filePath ? getLanguageFromPath(filePath) : null;
          if (output) html += formatExpandableOutput(output, 10, lang);
        }
        return html;
      }

      function renderWrite(name, args, result, ctx) {
        const filePath = str(args.file_path == null ? args.path : args.file_path);
        const content = str(args.content);
        const pathHtml = filePath === null ? invalidArgHtml() : escapeHtml(shortenPath(filePath || ''));
        const lineCount = (content != null && content !== '') ? content.split('\n').length : 0;
        const badges = lineCount > 10 ? ['(' + lineCount + ' lines)'] : null;
        let html = toolHead('write', pathHtml, badges);
        if (content === null) {
          html += '<div class="tool-error">[invalid content arg - expected string]</div>';
        } else if (content) {
          const lang = filePath ? getLanguageFromPath(filePath) : null;
          html += formatExpandableOutput(content, 10, lang);
        }
        if (result) {
          const output = ctx.getResultText().trim();
          if (output) html += '<div class="tool-output"><div>' + escapeHtml(output) + '</div></div>';
        }
        return html;
      }

      function renderEdit(name, args, result, ctx) {
        const filePath = str(args.file_path == null ? args.path : args.file_path);
        const pathHtml = filePath ? escapeHtml(shortenPath(filePath)) : '';
        let html = toolHead('edit', pathHtml);
        if (typeof args.input === 'string' && args.input.length) {
          html += codeBlock(args.input, null);
        } else if (Array.isArray(args.edits)) {
          html += '<div class="tool-args">';
          for (const e of args.edits) {
            const op = e && typeof e.op === 'string' ? e.op : '?';
            const sel = e && typeof e.sel === 'string' ? e.sel : '?';
            html += '<div class="tool-arg"><span class="tool-arg-key">' + escapeHtml(op) + '</span> <span class="tool-arg-val">' + escapeHtml(sel) + '</span></div>';
          }
          html += '</div>';
        }
        if (result?.details?.diff) {
          const diffLines = String(result.details.diff).split('\n');
          html += '<div class="tool-diff">';
          for (const line of diffLines) {
            const cls = line.match(/^\+/) ? 'diff-added' : line.match(/^-/) ? 'diff-removed' : 'diff-context';
            html += '<div class="' + cls + '">' + escapeHtml(replaceTabs(line)) + '</div>';
          }
          html += '</div>';
        } else if (result) {
          const output = ctx.getResultText().trim();
          if (output) html += '<div class="tool-output"><pre>' + escapeHtml(output) + '</pre></div>';
        }
        return html;
      }

      function renderAstEdit(name, args, result, ctx) {
        const lang = args.lang || null;
        const paths = Array.isArray(args.paths) ? args.paths.map(p => shortenPath(String(p))).join(', ') : (args.path ? shortenPath(String(args.path)) : '');
        const pathHtml = paths ? escapeHtml(paths) : '';
        const badges = [];
        if (lang) badges.push(lang);
        if (args.glob) badges.push('glob=' + args.glob);
        if (args.sel) badges.push('sel=' + args.sel);
        let html = toolHead('ast_edit', pathHtml, badges);
        if (Array.isArray(args.ops)) {
          for (const op of args.ops) {
            html += '<div class="tool-cell">';
            html += '<div class="tool-cell-title">pattern</div>';
            html += codeBlock(String(op?.pat == null ? '' : op.pat), lang);
            html += '<div class="tool-cell-title">replacement</div>';
            html += codeBlock(String(op?.out == null ? '' : op.out), lang);
            html += '</div>';
          }
        }
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 10);
        }
        return html;
      }

      function renderAstGrep(name, args, result, ctx) {
        const lang = args.lang || null;
        const pathHtml = args.path ? escapeHtml(shortenPath(String(args.path))) : '';
        const badges = [];
        if (lang) badges.push(lang);
        if (args.glob) badges.push('glob=' + args.glob);
        if (args.sel) badges.push('sel=' + args.sel);
        let html = toolHead('ast_grep', pathHtml, badges);
        if (Array.isArray(args.pat)) {
          for (const pat of args.pat) {
            html += '<div class="tool-cell">' + codeBlock(String(pat == null ? '' : pat), lang) + '</div>';
          }
        }
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 10);
        }
        return html;
      }

      function renderGrep(name, args, result, ctx) {
        const pattern = str(args.pattern);
        const pathHtml = args.path ? escapeHtml(shortenPath(String(args.path))) : escapeHtml('.');
        const patHtml = pattern === null ? invalidArgHtml() : escapeHtml(pattern);
        let head = '<span class="tool-name">grep</span> <span class="tool-pattern">/' + patHtml + '/</span>';
        head += ' <span class="tool-arg-key">in</span> <span class="tool-path">' + pathHtml + '</span>';
        const badges = [];
        if (args.glob) badges.push('glob=' + args.glob);
        if (args.type) badges.push('type=' + args.type);
        if (args.i) badges.push('i');
        if (args.multiline) badges.push('multiline');
        for (const b of badges) head += ' <span class="tool-badge">' + escapeHtml(b) + '</span>';
        let html = '<div class="tool-header">' + head + '</div>';
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 10);
        }
        return html;
      }

      function renderFind(name, args, result, ctx) {
        const paths = Array.isArray(args.paths) ? args.paths.map(p => shortenPath(String(p))).join(', ') : (str(args.pattern) || '.');
        const patHtml = paths ? escapeHtml(paths) : invalidArgHtml();
        const badges = [];
        if (args.limit) badges.push('limit=' + args.limit);
        if (args.hidden === false) badges.push('no-hidden');
        let html = toolHead('find', '<span class="tool-pattern">' + patHtml + '</span>', badges.length ? badges : null);
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 10);
        }
        return html;
      }

      function renderLsp(name, args, result, ctx) {
        const action = str(args.action) || '?';
        let head = '<span class="tool-name">lsp</span> <span class="tool-badge">' + escapeHtml(action) + '</span>';
        if (args.file && args.file !== '*') {
          head += ' <span class="tool-path">' + escapeHtml(shortenPath(String(args.file))) + '</span>';
        } else if (args.file === '*') {
          head += ' <span class="tool-badge">workspace</span>';
        }
        if (args.line) head += '<span class="line-numbers">:' + args.line + '</span>';
        if (args.symbol) head += ' <span class="tool-arg-val">' + escapeHtml(String(args.symbol)) + '</span>';
        if (args.query) head += ' <span class="tool-arg-key">query=</span><span class="tool-arg-val">' + escapeHtml(String(args.query)) + '</span>';
        if (args.new_name) head += ' <span class="tool-arg-key">→</span> <span class="tool-arg-val">' + escapeHtml(String(args.new_name)) + '</span>';
        let html = '<div class="tool-header">' + head + '</div>';
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 12);
        }
        return html;
      }

      function todoRoman(n) {
        if (n <= 0) return '';
        var pairs = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
        var out = '', rem = n;
        for (var i = 0; i < pairs.length; i++) {
          while (rem >= pairs[i][0]) { out += pairs[i][1]; rem -= pairs[i][0]; }
        }
        return out;
      }

      function renderTodoWrite(name, args, result, ctx) {
        let html = toolHead('todo_write');
        const ops = Array.isArray(args.ops) ? args.ops : null;
        if (ops) {
          html += '<div class="tool-args">';
          for (const op of ops) {
            const t = op && op.op ? op.op : '?';
            let line = '<span class="tool-arg-key">' + escapeHtml(t) + '</span>';
            if (op?.id) line += ' <span class="tool-arg-val">' + escapeHtml(String(op.id)) + '</span>';
            if (op?.status) line += ' <span class="tool-badge">' + escapeHtml(String(op.status)) + '</span>';
            if (op?.content) line += ' ' + escapeHtml(truncate(String(op.content), 80));
            if (op?.task && typeof op.task === 'object' && op.task.content) line += ' ' + escapeHtml(truncate(String(op.task.content), 80));
            html += '<div class="tool-arg">' + line + '</div>';
          }
          html += '</div>';
        }
        const phases = result?.details?.phases;
        if (Array.isArray(phases)) {
          html += '<div class="todo-tree">';
          for (var __i = 0; __i < phases.length; __i++) {
            var phase = phases[__i];
            var phaseLabel = todoRoman(__i + 1) + '. ' + String(phase.name || '');
            html += '<div class="todo-phase">' + escapeHtml(phaseLabel) + '</div>';
            if (Array.isArray(phase.tasks)) {
              for (const task of phase.tasks) {
                const status = task.status || 'pending';
                const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '→' : status === 'abandoned' ? '✕' : '○';
                html += '<div class="todo-task todo-' + status + '"><span class="todo-icon">' + icon + '</span> ' + escapeHtml(String(task.content || '')) + '</div>';
              }
            }
          }
          html += '</div>';
        } else if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 8);
        }
        return html;
      }

      function renderTask(name, args, result, ctx) {
        const agent = str(args.agent) || '?';
        const tasks = Array.isArray(args.tasks) ? args.tasks : [];
        const badges = ['agent=' + agent, tasks.length + ' subtask' + (tasks.length === 1 ? '' : 's')];
        if (args.isolated) badges.push('isolated');
        let html = toolHead('task', '', badges);
        if (tasks.length) {
          html += '<div class="tool-args">';
          for (const t of tasks) {
            const id = t?.id ? escapeHtml(String(t.id)) : '?';
            const desc = t?.description ? escapeHtml(String(t.description)) : '';
            html += '<div class="tool-arg"><span class="tool-arg-key">' + id + '</span> ' + desc + '</div>';
          }
          html += '</div>';
        }
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 12);
        }
        return html;
      }

      function renderWebSearch(name, args, result, ctx) {
        const query = str(args.query);
        const queryHtml = query === null ? invalidArgHtml() : escapeHtml(query);
        const badges = [];
        if (args.recency) badges.push('recency=' + args.recency);
        if (args.limit) badges.push('limit=' + args.limit);
        let html = toolHead('web_search', '<span class="tool-pattern">' + queryHtml + '</span>', badges);
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 12, 'markdown');
        }
        return html;
      }

      function renderFetch(name, args, result, ctx) {
        const url = str(args.url) || '';
        const badges = args.method ? [String(args.method)] : null;
        let html = toolHead('fetch', '<span class="tool-path">' + escapeHtml(url) + '</span>', badges);
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 10);
        }
        return html;
      }

      function renderDebug(name, args, result, ctx) {
        const action = str(args.action) || '?';
        const badges = [];
        if (args.adapter) badges.push(args.adapter);
        if (args.program) badges.push('program=' + shortenPath(String(args.program)));
        if (args.file) badges.push('file=' + shortenPath(String(args.file)));
        if (args.line) badges.push('line=' + args.line);
        let head = '<span class="tool-name">debug</span> <span class="tool-badge">' + escapeHtml(action) + '</span>';
        for (const b of badges) head += ' <span class="tool-badge">' + escapeHtml(String(b)) + '</span>';
        let html = '<div class="tool-header">' + head + '</div>';
        if (args.expression) html += codeBlock(String(args.expression));
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 10);
        }
        return html;
      }

      function renderBrowser(name, args, result, ctx) {
        const action = str(args.action) || '?';
        const tabName = str(args.name);
        const badges = [];
        if (tabName) badges.push('name=' + tabName);
        if (args.url) badges.push(String(args.url));
        if (args.app && typeof args.app === 'object') {
          if (args.app.path) badges.push('app=' + shortenPath(String(args.app.path)));
          else if (args.app.cdp_url) badges.push('cdp=' + String(args.app.cdp_url));
        }
        if (args.all) badges.push('all');
        if (args.kill) badges.push('kill');
        let head = '<span class="tool-name">browser</span> <span class="tool-badge">' + escapeHtml(action) + '</span>';
        for (const b of badges) head += ' <span class="tool-badge">' + escapeHtml(String(b)) + '</span>';
        let html = '<div class="tool-header">' + head + '</div>';
        if (action === 'run' && args.code) {
          html += codeBlock(String(args.code), 'javascript');
        }
        if (result) {
          html += ctx.renderResultImages();
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 10);
        }
        return html;
      }

      function renderGenerateImage(name, args, result, ctx) {
        const subject = str(args.subject) || '';
        const badges = args.aspect_ratio ? [String(args.aspect_ratio)] : null;
        let html = toolHead('generate_image', '', badges);
        if (subject) html += '<div class="tool-output"><div>' + escapeHtml(subject) + '</div></div>';
        if (result) {
          html += ctx.renderResultImages();
        }
        return html;
      }

      function renderAsk(name, args, result, ctx) {
        let html = toolHead('ask');
        const questions = Array.isArray(args.questions) ? args.questions : null;
        if (questions) {
          html += '<div class="tool-args">';
          for (const q of questions) {
            html += '<div class="tool-arg"><span class="tool-arg-key">Q:</span> ' + escapeHtml(String(q?.question || '')) + '</div>';
            if (Array.isArray(q?.options)) {
              for (const opt of q.options) {
                html += '<div class="tool-arg"><span class="tool-arg-key">  -</span> ' + escapeHtml(String(opt?.label || '')) + '</div>';
              }
            }
          }
          html += '</div>';
        }
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 8);
        }
        return html;
      }

      function renderResolve(name, args, result, ctx) {
        const action = str(args.action) || '?';
        let html = toolHead('resolve', '', [action]);
        if (args.reason) html += '<div class="tool-output"><div>' + escapeHtml(String(args.reason)) + '</div></div>';
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 6);
        }
        return html;
      }

      function renderGh(name, args, result, ctx) {
        const op = str(args.op);
        const badges = [];
        if (op) badges.push(op);
        if (args.repo) badges.push(String(args.repo));
        if (args.issue) badges.push('#' + args.issue);
        if (args.pr) badges.push(Array.isArray(args.pr) ? 'PRs ' + args.pr.join(',') : 'PR ' + args.pr);
        if (args.branch) badges.push('branch=' + args.branch);
        if (args.query) badges.push('query=' + truncate(String(args.query), 60));
        if (args.run) badges.push('run=' + args.run);
        if (args.title) badges.push('title=' + truncate(String(args.title), 40));
        let html = toolHead(name, '', badges);
        if (args.body) html += '<div class="tool-output"><div>' + escapeHtml(truncate(String(args.body), 400)) + '</div></div>';
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 12, 'markdown');
        }
        return html;
      }

      function renderMermaid(name, args, result, ctx) {
        let html = toolHead('render_mermaid');
        const code = args.code || args.source;
        if (code) html += codeBlock(String(code), 'mermaid');
        if (result) {
          html += ctx.renderResultImages();
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 6);
        }
        return html;
      }

      function renderYield(name, args, result, ctx) {
        let html = toolHead('yield');
        if (args.data !== undefined) {
          html += '<div class="tool-output"><pre>' + escapeHtml(JSON.stringify(args.data, null, 2)) + '</pre></div>';
        }
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 6);
        }
        return html;
      }

      function renderReportFinding(name, args, result, ctx) {
        const badges = [];
        if (args.priority) badges.push('priority=' + args.priority);
        if (args.confidence != null) badges.push('confidence=' + args.confidence);
        if (args.file_path) badges.push(shortenPath(String(args.file_path)));
        let html = toolHead('report_finding', args.title ? escapeHtml(String(args.title)) : '', badges);
        if (args.body) html += '<div class="tool-output"><div>' + escapeHtml(String(args.body)) + '</div></div>';
        return html;
      }

      function renderCalc(name, args, result, ctx) {
        let html = toolHead('calc');
        const exprs = args.expressions || (args.expression ? [args.expression] : []);
        for (const e of exprs) html += codeBlock(String(e), 'plaintext');
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 6);
        }
        return html;
      }

      function renderJob(name, args, result, ctx) {
        const badges = [];
        const pollIds = Array.isArray(args.poll) ? args.poll : Array.isArray(args.jobs) ? args.jobs : Array.isArray(args.jobIds) ? args.jobIds : [];
        const cancelIds = Array.isArray(args.cancel) ? args.cancel : args.jobId ? [String(args.jobId)] : [];
        if (cancelIds.length > 0) badges.push('cancel ' + cancelIds.length);
        if (pollIds.length > 0) badges.push('poll ' + pollIds.length);
        let html = toolHead('job', '', badges);
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 8);
        }
        return html;
      }

      // Parse `*** Cell <attrs>` headers (canonical), plus legacy
      // `*** Begin <LANG>` headers and `===== <info> =====` bars used in
      // older transcripts. Cells emitted before each format cutover still
      // need to render in HTML exports.
      function parseEvalCells(input) {
        const text = String(input);
        if (/^[*]{2,}\s*Cell\b/im.test(text)) return parseEvalCellsCell(text);
        if (/^[*]{2,}\s*Begin\b/im.test(text)) return parseEvalCellsBegin(text);
        return parseEvalCellsLegacy(text);
      }

      function evalLangAlias(token) {
        const t = String(token || '').toUpperCase();
        if (t === 'PY' || t === 'PYTHON' || t === 'IPY' || t === 'IPYTHON') return 'py';
        if (t === 'JS' || t === 'JAVASCRIPT') return 'js';
        if (t === 'TS' || t === 'TYPESCRIPT') return 'ts';
        return null;
      }

      // Tokenize a `*** Cell` header attribute list, preserving quoted
      // segments. Mirrors `tokenizeCellAttrs` in src/eval/parse.ts.
      function tokenizeCellAttrsHtml(input) {
        const tokens = [];
        let i = 0;
        while (i < input.length) {
          while (i < input.length && /\s/.test(input[i])) i++;
          if (i >= input.length) break;
          let tok = '';
          while (i < input.length && !/\s/.test(input[i])) {
            const ch = input[i];
            if (ch === '"' || ch === "'") {
              tok += ch; i++;
              while (i < input.length && input[i] !== ch) { tok += input[i]; i++; }
              if (i < input.length) { tok += input[i]; i++; }
            } else { tok += ch; i++; }
          }
          tokens.push(tok);
        }
        return tokens;
      }

      function parseEvalCellsCell(text) {
        const STARS = '\\*{2,}';
        const CELL = new RegExp('^' + STARS + '\\s*Cell\\b\\s*(.*)$', 'i');
        const END = new RegExp('^' + STARS + '\\s*End\\b.*$', 'i');
        const ATTR = /^([a-zA-Z][\w-]*)(?::(?:"([^"]*)"|'([^']*)'|(.*)))?$/;
        const DUR = /^\d+(?:ms|s|m)?$/;
        const ID_KEYS = ['id', 'title', 'name', 'cell', 'file', 'label'];
        const T_KEYS = ['t', 'timeout', 'duration', 'time'];
        const RST_KEYS = ['rst', 'reset'];
        const lines = text.split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        const cells = [];
        let i = 0;
        while (i < lines.length && lines[i].trim() === '') i++;
        while (i < lines.length) {
          const m = CELL.exec(lines[i]);
          if (!m) { i++; continue; }
          const tokens = tokenizeCellAttrsHtml(m[1] || '');
          let lang = null;
          let title = '';
          const attrs = [];
          let bareReset = false;
          const titleParts = [];
          for (const tok of tokens) {
            const lower = tok.toLowerCase();
            if (RST_KEYS.indexOf(lower) >= 0) { bareReset = true; continue; }
            const am = ATTR.exec(tok);
            if (am && tok.indexOf(':') >= 0) {
              const key = am[1].toLowerCase();
              const value = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : (am[4] || '');
              const lc = evalLangAlias(key);
              if (lc) {
                if (!lang) lang = lc;
                if (!title && value) title = value;
                continue;
              }
              if (ID_KEYS.indexOf(key) >= 0) { if (!title) title = value; continue; }
              if (T_KEYS.indexOf(key) >= 0) { attrs.push('t=' + value); continue; }
              if (RST_KEYS.indexOf(key) >= 0) { attrs.push('rst'); continue; }
              continue;
            }
            const lc = evalLangAlias(tok);
            if (lc && !lang) { lang = lc; continue; }
            if (DUR.test(tok)) { attrs.push('t=' + tok); continue; }
            titleParts.push(tok);
          }
          if (!title && titleParts.length) title = titleParts.join(' ');
          if (bareReset) attrs.push('rst');
          lang = lang || 'py';
          i++;
          const codeLines = [];
          while (i < lines.length) {
            if (END.test(lines[i])) { i++; break; }
            if (CELL.test(lines[i])) break;
            codeLines.push(lines[i]);
            i++;
          }
          while (codeLines.length && codeLines[codeLines.length - 1].trim() === '') codeLines.pop();
          cells.push({ lang, title, attrs, code: codeLines.join('\n') });
          while (i < lines.length && lines[i].trim() === '') i++;
        }
        return cells;
      }

      function parseEvalCellsBegin(text) {
        const STARS = '\\*{2,}';
        const BEGIN = new RegExp('^' + STARS + '\\s*Begin\\b\\s*(\\S+)?\\s*$', 'i');
        const END = new RegExp('^' + STARS + '\\s*End\\b.*$', 'i');
        const TITLE = new RegExp('^' + STARS + '\\s*Title\\s*:\\s*(.+?)\\s*$', 'i');
        const TIMEOUT = new RegExp('^' + STARS + '\\s*Timeout\\s*:\\s*(\\S+)\\s*$', 'i');
        const RESET = new RegExp('^' + STARS + '\\s*Reset\\s*$', 'i');
        const lines = text.split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        const cells = [];
        let i = 0;
        while (i < lines.length && lines[i].trim() === '') i++;
        while (i < lines.length) {
          const beginMatch = BEGIN.exec(lines[i]);
          if (!beginMatch) { i++; continue; }
          const lang = evalLangAlias(beginMatch[1]) || 'py';
          i++;
          let title = '';
          const attrs = [];
          while (i < lines.length) {
            const tm = TITLE.exec(lines[i]);
            if (tm) { if (!title) title = tm[1]; i++; continue; }
            const to = TIMEOUT.exec(lines[i]);
            if (to) { attrs.push('t=' + to[1]); i++; continue; }
            if (RESET.test(lines[i])) { attrs.push('rst'); i++; continue; }
            break;
          }
          const codeLines = [];
          while (i < lines.length) {
            if (END.test(lines[i])) { i++; break; }
            if (BEGIN.test(lines[i])) break;
            codeLines.push(lines[i]);
            i++;
          }
          while (codeLines.length && codeLines[codeLines.length - 1].trim() === '') codeLines.pop();
          cells.push({ lang, title, attrs, code: codeLines.join('\n') });
          while (i < lines.length && lines[i].trim() === '') i++;
        }
        return cells;
      }

      function parseEvalCellsLegacy(input) {
        const HEADER = /^={5,}\s*(.*?)\s*={5,}\s*$/;
        const lines = String(input).split('\n');
        const cells = [];
        let inheritedLang = 'py';
        let current = null;
        for (const line of lines) {
          const m = line.match(HEADER);
          if (m) {
            if (current) cells.push(current);
            const info = m[1] || '';
            let lang = inheritedLang;
            let title = '';
            const langMatch = info.match(/^(py|js|ts)(?::"([^"]*)")?/);
            if (langMatch) {
              lang = langMatch[1];
              if (langMatch[2]) title = langMatch[2];
            }
            if (!title) {
              const idMatch = info.match(/id:"([^"]*)"/);
              if (idMatch) title = idMatch[1];
            }
            inheritedLang = lang;
            const attrs = [];
            const tMatch = info.match(/(?:^|\s)t:(\S+)/);
            if (tMatch) attrs.push('t=' + tMatch[1]);
            if (/(?:^|\s)rst(?:\s|$)/.test(info)) attrs.push('rst');
            current = { lang, title, attrs, code: '' };
          } else {
            if (!current) current = { lang: inheritedLang, title: '', attrs: [], code: '' };
            current.code += (current.code ? '\n' : '') + line;
          }
        }
        if (current) cells.push(current);
        return cells.map(c => ({ ...c, code: c.code.replace(/\s+$/, '') }));
      }

      function evalLangToHljs(lang) {
        return lang === 'py' ? 'python' : lang === 'js' ? 'javascript' : lang === 'ts' ? 'typescript' : null;
      }

      function renderEval(name, args, result, ctx) {
        let html = toolHead('eval');
        if (typeof args.input !== 'string') {
          html += '<div class="tool-error">[missing input]</div>';
        } else {
          const cells = parseEvalCells(args.input);
          if (cells.length === 0) {
            html += codeBlock(args.input, 'python');
          } else {
            for (const cell of cells) {
              html += '<div class="tool-cell">';
              const titleParts = [];
              if (cell.title) titleParts.push(cell.title);
              titleParts.push(cell.lang);
              if (cell.attrs && cell.attrs.length) titleParts.push(...cell.attrs);
              html += '<div class="tool-cell-title">' + escapeHtml(titleParts.join(' · ')) + '</div>';
              html += codeBlock(cell.code, evalLangToHljs(cell.lang));
              html += '</div>';
            }
          }
        }
        if (result) {
          html += ctx.renderResultImages();
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 12);
        }
        return html;
      }

      function renderSearch(name, args, result, ctx) {
        const pattern = str(args.pattern);
        const paths = Array.isArray(args.paths) ? args.paths.map(p => shortenPath(String(p))).join(', ') : (args.path ? shortenPath(String(args.path)) : '.');
        const patHtml = pattern === null ? invalidArgHtml() : escapeHtml(pattern);
        let head = '<span class="tool-name">search</span> <span class="tool-pattern">/' + patHtml + '/</span>';
        head += ' <span class="tool-arg-key">in</span> <span class="tool-path">' + escapeHtml(paths) + '</span>';
        const badges = [];
        if (args.i) badges.push('i');
        if (args.skip) badges.push('skip=' + args.skip);
        if (args.gitignore === false) badges.push('no-gitignore');
        for (const b of badges) head += ' <span class="tool-badge">' + escapeHtml(b) + '</span>';
        let html = '<div class="tool-header">' + head + '</div>';
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 12);
        }
        return html;
      }

      function renderRecipe(name, args, result, ctx) {
        const op = str(args.op) || '?';
        let html = toolHead('recipe', '<span class="tool-arg-val">' + escapeHtml(op) + '</span>');
        if (result) {
          html += ctx.renderResultImages();
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 10);
        }
        return html;
      }

      function renderIrc(name, args, result, ctx) {
        const op = str(args.op) || '?';
        const badges = [op];
        if (args.to) badges.push('to=' + args.to);
        if (args.awaitReply === false) badges.push('no-reply');
        let html = toolHead('irc', '', badges);
        if (args.message) html += '<div class="tool-output"><div>' + escapeHtml(String(args.message)) + '</div></div>';
        if (result) {
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 8);
        }
        return html;
      }


      function renderGenericTool(name, args, result, ctx) {
        let html = toolHead(name);
        const argText = JSON.stringify(args, null, 2);
        if (argText && argText !== '{}') {
          html += '<div class="tool-output"><pre>' + escapeHtml(argText) + '</pre></div>';
        }
        if (result) {
          html += ctx.renderResultImages();
          const output = ctx.getResultText();
          if (output) html += formatExpandableOutput(output, 10);
        }
        return html;
      }

      const TOOL_RENDERERS = {
        bash: renderBash,
        eval: renderEval,
        js: renderJsLike,
        python: renderJsLike,
        notebook: renderJsLike,
        read: renderRead,
        write: renderWrite,
        edit: renderEdit,
        ast_edit: renderAstEdit,
        ast_grep: renderAstGrep,
        grep: renderGrep,
        search: renderSearch,
        find: renderFind,
        lsp: renderLsp,
        todo_write: renderTodoWrite,
        task: renderTask,
        web_search: renderWebSearch,
        fetch: renderFetch,
        debug: renderDebug,
        puppeteer: renderBrowser,
        browser: renderBrowser,
        generate_image: renderGenerateImage,
        ask: renderAsk,
        resolve: renderResolve,
        github: renderGh,
        render_mermaid: renderMermaid,
        yield: renderYield,
        report_finding: renderReportFinding,
        calc: renderCalc,
        calculator: renderCalc,
        await: renderJob,
        poll: renderJob,
        cancel_job: renderJob,
        job: renderJob,
        recipe: renderRecipe,
        irc: renderIrc,
      };

      function renderToolCall(call) {
        const result = findToolResult(call.id);
        const isError = result?.isError || false;
        const statusClass = result ? (isError ? 'error' : 'success') : 'pending';
        const rawArgs = call.arguments || {};
        const intent = typeof rawArgs._i === 'string' ? rawArgs._i.trim() : '';
        // Strip internal _i intent so renderers don't dump it as JSON.
        const args = {};
        for (const k of Object.keys(rawArgs)) {
          if (k !== '_i') args[k] = rawArgs[k];
        }
        const name = call.name;

        const ctx = {
          intent,
          getResultText: () => {
            if (!result) return '';
            const textBlocks = result.content.filter(c => c.type === 'text');
            return textBlocks.map(c => c.text).join('\n');
          },
          getResultImages: () => {
            if (!result) return [];
            return result.content.filter(c => c.type === 'image');
          },
          renderResultImages: () => {
            if (!result) return '';
            const images = result.content.filter(c => c.type === 'image');
            if (images.length === 0) return '';
            return '<div class="tool-images">' +
              images.map(img => renderDataImage(img, 'tool-image')).join('') +
              '</div>';
          },
        };

        const renderer = TOOL_RENDERERS[name] || renderGenericTool;
        let html = '<div class="tool-execution ' + statusClass + '">';
        if (intent) html += '<div class="tool-intent">' + escapeHtml(intent) + '</div>';
        try {
          html += renderer(name, args, result, ctx);
        } catch (err) {
          html += renderGenericTool(name, args, result, ctx);
        }
        html += '</div>';
        return html;
      }


      /**
       * Build a shareable URL for a specific message.
       * URL format: base?gistId&leafId=<leafId>&targetId=<entryId>
       */
      function buildShareUrl(entryId) {
        // Check for injected base URL (used when loaded in iframe via srcdoc)
        const baseUrlMeta =
          document.querySelector('meta[name="gjc-share-base-url"]') ||
          document.querySelector('meta[name="pi-share-base-url"]');
        const baseUrl = baseUrlMeta ? baseUrlMeta.content : window.location.href.split('?')[0];

        const url = new URL(window.location.href);
        // Find the gist ID (first query param without value, e.g., ?abc123)
        const gistId = Array.from(url.searchParams.keys()).find(k => !url.searchParams.get(k));

        // Build the share URL
        const params = new URLSearchParams();
        params.set('leafId', currentLeafId);
        params.set('targetId', entryId);

        // If we have an injected base URL (iframe context), use it directly
        if (baseUrlMeta) {
          return `${baseUrl}&${params.toString()}`;
        }

        // Otherwise build from current location (direct file access)
        url.search = gistId ? `?${gistId}&${params.toString()}` : `?${params.toString()}`;
        return url.toString();
      }

      /**
       * Copy text to clipboard with visual feedback.
       * Uses navigator.clipboard with fallback to execCommand for HTTP contexts.
       */
      async function copyToClipboard(text, button) {
        let success = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            success = true;
          }
        } catch {
          // Clipboard API failed, try fallback
        }

        // Fallback for HTTP or when Clipboard API is unavailable
        if (!success) {
          try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            success = document.execCommand('copy');
            document.body.removeChild(textarea);
          } catch {
          }
        }

        if (success && button) {
          const originalHtml = button.innerHTML;
          button.innerHTML = '✓';
          button.classList.add('copied');
          setTimeout(() => {
            button.innerHTML = originalHtml;
            button.classList.remove('copied');
          }, 1500);
        }
      }

      /**
       * Render the copy-link button HTML for a message.
       */
      function renderCopyLinkButton(entryId) {
        return `<button class="copy-link-btn" data-entry-id="${escapeHtmlAttribute(entryId)}" title="Copy link to this message">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        </button>`;
      }

      function renderEntry(entry) {
        const ts = formatTimestamp(entry.timestamp);
        const tsHtml = ts ? `<div class="message-timestamp">${escapeHtml(ts)}</div>` : '';
        const entryId = escapeHtmlAttribute(`entry-${entry.id}`);
        const copyBtnHtml = renderCopyLinkButton(entry.id);

        if (entry.type === 'message') {
          const msg = entry.message;

          if (msg.role === 'user') {
            let html = `<div class="user-message" id="${entryId}">${copyBtnHtml}${tsHtml}`;
            const content = msg.content;

            if (Array.isArray(content)) {
              const images = content.filter(c => c.type === 'image');
              if (images.length > 0) {
                html += '<div class="message-images">';
                for (const img of images) {
                  html += renderDataImage(img, 'message-image');
                }
                html += '</div>';
              }
            }

            const text = typeof content === 'string' ? content : 
              content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            if (text.trim()) {
              html += `<div class="markdown-content">${safeMarkedParse(text)}</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'developer') {
            let html = `<div class="user-message developer-message" id="${entryId}">${copyBtnHtml}${tsHtml}`;
            const content = msg.content;
            const text = typeof content === 'string' ? content :
              content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            if (text.trim()) {
              html += `<div class="markdown-content">${safeMarkedParse(text)}</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'assistant') {
            let html = `<div class="assistant-message" id="${entryId}">${copyBtnHtml}${tsHtml}`;

            for (const block of msg.content) {
              if (block.type === 'text' && block.text.trim()) {
                html += `<div class="assistant-text markdown-content">${safeMarkedParse(block.text)}</div>`;
              } else if (block.type === 'thinking' && block.thinking.trim()) {
                html += `<div class="thinking-block">
                  <div class="thinking-text">${escapeHtml(block.thinking)}</div>
                  <div class="thinking-collapsed">Thinking ...</div>
                </div>`;
              }
            }

            for (const block of msg.content) {
              if (block.type === 'toolCall') {
                html += renderToolCall(block);
              }
            }

            if (msg.stopReason === 'aborted') {
              html += '<div class="error-text">Aborted</div>';
            } else if (msg.stopReason === 'error') {
              html += `<div class="error-text">Error: ${escapeHtml(msg.errorMessage || 'Unknown error')}</div>`;
            }

            html += '</div>';
            return html;
          }

          if (msg.role === 'bashExecution') {
            const isError = msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null);
            let html = `<div class="tool-execution ${isError ? 'error' : 'success'}" id="${entryId}">${tsHtml}`;
            html += `<div class="tool-command">$ ${escapeHtml(msg.command)}</div>`;
            if (msg.output) html += formatExpandableOutput(msg.output, 10);
            if (msg.cancelled) {
              html += '<div style="color: var(--warning)">(cancelled)</div>';
            } else if (msg.exitCode !== 0 && msg.exitCode !== null) {
              html += `<div style="color: var(--error)">(exit ${escapeHtml(msg.exitCode)})</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'jsExecution') {
            const isError = msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null);
            let html = `<div class="tool-execution ${isError ? 'error' : 'success'}" id="${entryId}">${tsHtml}`;
            html += `<div class="tool-command">$ ${escapeHtml(msg.code)}</div>`;
            if (msg.output) html += formatExpandableOutput(msg.output, 10);
            if (msg.cancelled) {
              html += '<div style="color: var(--warning)">(cancelled)</div>';
            } else if (msg.exitCode !== 0 && msg.exitCode !== null) {
              html += `<div style="color: var(--error)">(exit ${escapeHtml(msg.exitCode)})</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'toolResult') return '';
        }

        if (entry.type === 'model_change') {
          const html = `<div class="model-change" id="${entryId}">${tsHtml}Switched to model: <span class="model-name">${escapeHtml(entry.model)}</span></div>`;
          return html;
        }

        if (entry.type === 'thinking_level_change') {
          const html = `<div class="thinking-change" id="${entryId}">${tsHtml}Thinking level: <span class="thinking-level">${escapeHtml(entry.thinkingLevel)}</span></div>`;
          return html;
        }


        if (entry.type === 'compaction') {
          const tokensBefore = escapeHtml(entry.tokensBefore.toLocaleString());
          return `<div class="compaction" id="${entryId}" onclick="this.classList.toggle('expanded')">
            <div class="compaction-label">[compaction]</div>
            <div class="compaction-collapsed">Compacted from ${tokensBefore} tokens</div>
            <div class="compaction-content"><strong>Compacted from ${tokensBefore} tokens</strong>\n\n${escapeHtml(entry.summary)}</div>
          </div>`;
        }

        if (entry.type === 'branch_summary') {
          return `<div class="branch-summary" id="${entryId}">${tsHtml}
            <div class="branch-summary-header">Branch Summary</div>
            <div class="markdown-content">${safeMarkedParse(entry.summary)}</div>
          </div>`;
        }

        if (entry.type === 'custom_message' && entry.display) {
          return `<div class="hook-message" id="${entryId}">${tsHtml}
            <div class="hook-type">[${escapeHtml(entry.customType)}]</div>
            <div class="markdown-content">${safeMarkedParse(typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content))}</div>
          </div>`;
        }

        return '';
      }

      // ============================================================
      // HEADER / STATS
      // ============================================================

      function computeStats(entryList) {
        let userMessages = 0, developerMessages = 0, assistantMessages = 0, toolResults = 0;
        let customMessages = 0, compactions = 0, branchSummaries = 0, toolCalls = 0;
        const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const models = new Set();

        for (const entry of entryList) {
          if (entry.type === 'message') {
            const msg = entry.message;
            if (msg.role === 'user') userMessages++;
            if (msg.role === 'developer') developerMessages++;
            if (msg.role === 'assistant') {
              assistantMessages++;
              if (msg.model) models.add(msg.provider ? `${msg.provider}/${msg.model}` : msg.model);
              if (msg.usage) {
                tokens.input += msg.usage.input || 0;
                tokens.output += msg.usage.output || 0;
                tokens.cacheRead += msg.usage.cacheRead || 0;
                tokens.cacheWrite += msg.usage.cacheWrite || 0;
                if (msg.usage.cost) {
                  cost.input += msg.usage.cost.input || 0;
                  cost.output += msg.usage.cost.output || 0;
                  cost.cacheRead += msg.usage.cost.cacheRead || 0;
                  cost.cacheWrite += msg.usage.cost.cacheWrite || 0;
                }
              }
              toolCalls += msg.content.filter(c => c.type === 'toolCall').length;
            }
            if (msg.role === 'toolResult') toolResults++;
          } else if (entry.type === 'compaction') {
            compactions++;
          } else if (entry.type === 'branch_summary') {
            branchSummaries++;
          } else if (entry.type === 'custom_message') {
            customMessages++;
          }
        }

        return { userMessages, developerMessages, assistantMessages, toolResults, customMessages, compactions, branchSummaries, toolCalls, tokens, cost, models: Array.from(models) };
      }

      const globalStats = computeStats(entries);

      function renderHeader() {
        const totalCost = globalStats.cost.input + globalStats.cost.output + globalStats.cost.cacheRead + globalStats.cost.cacheWrite;

        const tokenParts = [];
        if (globalStats.tokens.input) tokenParts.push(`↑${formatTokens(globalStats.tokens.input)}`);
        if (globalStats.tokens.output) tokenParts.push(`↓${formatTokens(globalStats.tokens.output)}`);
        if (globalStats.tokens.cacheRead) tokenParts.push(`R${formatTokens(globalStats.tokens.cacheRead)}`);
        if (globalStats.tokens.cacheWrite) tokenParts.push(`W${formatTokens(globalStats.tokens.cacheWrite)}`);

        const msgParts = [];
        if (globalStats.userMessages) msgParts.push(`${globalStats.userMessages} user`);
        if (globalStats.developerMessages) msgParts.push(`${globalStats.developerMessages} developer`);
        if (globalStats.assistantMessages) msgParts.push(`${globalStats.assistantMessages} assistant`);
        if (globalStats.toolResults) msgParts.push(`${globalStats.toolResults} tool results`);
        if (globalStats.customMessages) msgParts.push(`${globalStats.customMessages} custom`);
        if (globalStats.compactions) msgParts.push(`${globalStats.compactions} compactions`);
        if (globalStats.branchSummaries) msgParts.push(`${globalStats.branchSummaries} branch summaries`);

        let html = `
          <div class="header">
            <div class="brand-kicker">gajae-code · red-claw transcript</div>
            <h1>GJC Session Export: ${escapeHtml(header?.id || 'unknown')}</h1>
            <div class="help-bar">Ctrl+T toggle thinking · Ctrl+O toggle tools</div>
            <div class="header-info">
              <div class="info-item"><span class="info-label">Product:</span><span class="info-value">GJC / gajae-code</span></div>
              <div class="info-item"><span class="info-label">Date:</span><span class="info-value">${escapeHtml(header?.timestamp ? new Date(header.timestamp).toLocaleString() : 'unknown')}</span></div>
              <div class="info-item"><span class="info-label">Models:</span><span class="info-value">${escapeHtml(globalStats.models.join(', ') || 'unknown')}</span></div>
              <div class="info-item"><span class="info-label">Messages:</span><span class="info-value">${msgParts.join(', ') || '0'}</span></div>
              <div class="info-item"><span class="info-label">Tool Calls:</span><span class="info-value">${globalStats.toolCalls}</span></div>
              <div class="info-item"><span class="info-label">Tokens:</span><span class="info-value">${tokenParts.join(' ') || '0'}</span></div>
              <div class="info-item"><span class="info-label">Cost:</span><span class="info-value">$${totalCost.toFixed(3)}</span></div>
            </div>
          </div>`;

        if (systemPrompt) {
          html += `<div class="system-prompt">
            <div class="system-prompt-header">System Prompt</div>
            <div class="system-prompt-content">${escapeHtml(systemPrompt)}</div>
          </div>`;
        }

        if (tools && tools.length > 0) {
          const namesHtml = tools.map(t => `<span class="tool-name-chip">${escapeHtml(t.name)}</span>`).join('');
          const fullHtml = tools.map(t => `<div class="tool-item"><span class="tool-item-name">${escapeHtml(t.name)}</span> - <span class="tool-item-desc">${escapeHtml(t.description)}</span></div>`).join('');
          html += `<div class="tools-list collapsed" onclick="this.classList.toggle('collapsed')">
            <div class="tools-header">Available Tools (${tools.length})</div>
            <div class="tools-collapsed">${namesHtml}</div>
            <div class="tools-content">${fullHtml}</div>
          </div>`;
        }

        return html;
      }

      // ============================================================
      // NAVIGATION
      // ============================================================

      // Cache for rendered entry DOM nodes
      const entryCache = new Map();

      function renderEntryToNode(entry) {
        // Check cache first
        if (entryCache.has(entry.id)) {
          return entryCache.get(entry.id).cloneNode(true);
        }

        // Render to HTML string, then parse to node
        const html = renderEntry(entry);
        if (!html) return null;

        const template = document.createElement('template');
        template.innerHTML = html;
        const node = template.content.firstElementChild;

        // Cache the node
        if (node) {
          entryCache.set(entry.id, node.cloneNode(true));
        }
        return node;
      }

      function navigateTo(targetId, scrollMode = 'target', scrollToEntryId = null) {
        currentLeafId = targetId;
        currentTargetId = scrollToEntryId || targetId;
        const path = getPath(targetId);

        renderTree();

        document.getElementById('header-container').innerHTML = renderHeader();

        // Build messages using cached DOM nodes
        const messagesEl = document.getElementById('messages');
        const fragment = document.createDocumentFragment();

        for (const entry of path) {
          const node = renderEntryToNode(entry);
          if (node) {
            fragment.appendChild(node);
          }
        }

        messagesEl.innerHTML = '';
        messagesEl.appendChild(fragment);

        // Attach click handlers for copy-link buttons
        messagesEl.querySelectorAll('.copy-link-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entryId = btn.dataset.entryId;
            const shareUrl = buildShareUrl(entryId);
            copyToClipboard(shareUrl, btn);
          });
        });

        // Use setTimeout(0) to ensure DOM is fully laid out before scrolling
        setTimeout(() => {
          const content = document.getElementById('content');
          if (scrollMode === 'bottom') {
            content.scrollTop = content.scrollHeight;
          } else if (scrollMode === 'target') {
            const scrollTargetId = scrollToEntryId || targetId;
            const targetEl = document.getElementById(`entry-${scrollTargetId}`);
            if (targetEl) {
              targetEl.scrollIntoView({ block: 'center' });
              if (scrollToEntryId) {
                targetEl.classList.add('highlight');
                setTimeout(() => targetEl.classList.remove('highlight'), 2000);
              }
            }
          }
        }, 0);
      }

      // ============================================================
      // INITIALIZATION
      // ============================================================

      // Escape raw HTML tags in markdown text while keeping markdown/code rendering.
      function escapeHtmlTags(text) {
        return text.replace(/<(?=[a-zA-Z\/])/g, '&lt;');
      }

      function sanitizeMarkdownUrl(href) {
        const value = String(href || '').trim();
        if (!value) return '';

        // Collapse whitespace/control characters before scheme checks so
        // variants like "java\nscript:" cannot bypass the allowlist.
        const compact = value.replace(/[\u0000-\u001F\u007F\s]+/g, '');
        // Browser URL parsing treats backslashes in leading path separators as
        // network-path separators; Marked may pass them through or encode them.
        if (compact.includes('\\') || /%5c/i.test(compact)) return null;

        const colonIndex = compact.indexOf(':');
        const firstPathIndex = compact.search(/[/?#]/);
        if (colonIndex !== -1 && (firstPathIndex === -1 || colonIndex < firstPathIndex)) {
          const scheme = compact.slice(0, colonIndex).toLowerCase();
          if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') {
            return value;
          }
          return null;
        }

        if (compact.startsWith('//')) return null;
        return value;
      }

      function renderAttribute(name, value) {
        return value ? ` ${name}="${escapeHtmlAttribute(value)}"` : '';
      }

      function renderUnsafeLinkText(tokens, href) {
        const text = this.parser.parseInline(tokens);
        return href ? `${text} (${escapeHtml(href)})` : text;
      }

      function renderUnsafeImageText(text, href) {
        return href ? `![${escapeHtml(text)}](${escapeHtml(href)})` : `![${escapeHtml(text)}]`;
      }

      // Configure marked with syntax highlighting and raw HTML escaping
      marked.use({
        breaks: true,
        gfm: true,
        renderer: {
          // Code blocks: syntax highlight, no HTML escaping
          code(token) {
            const code = token.text;
            const lang = token.lang;
            let highlighted;
            if (lang && hljs.getLanguage(lang)) {
              try {
                highlighted = hljs.highlight(code, { language: lang }).value;
              } catch {
                highlighted = escapeHtml(code);
              }
            } else {
              // Auto-detect language if not specified
              try {
                highlighted = hljs.highlightAuto(code).value;
              } catch {
                highlighted = escapeHtml(code);
              }
            }
            return `<pre><code class="hljs">${highlighted}</code></pre>`;
          },
          // Text content: escape HTML tags
          text(token) {
            return escapeHtmlTags(escapeHtml(token.text));
          },
          // Raw HTML: render as text, never as executable DOM
          html(token) {
            return escapeHtml(token.raw || token.text || '');
          },
          // Inline code: escape HTML
          codespan(token) {
            return `<code>${escapeHtml(token.text)}</code>`;
          },
          link(token) {
            const href = token.href || '';
            const sanitizedHref = sanitizeMarkdownUrl(href);
            if (sanitizedHref === null) {
              return renderUnsafeLinkText.call(this, token.tokens || [], href);
            }
            return `<a href="${escapeHtmlAttribute(sanitizedHref)}"${renderAttribute('title', token.title)}>${this.parser.parseInline(token.tokens || [])}</a>`;
          },
          image(token) {
            const href = token.href || '';
            const sanitizedHref = sanitizeMarkdownUrl(href);
            if (sanitizedHref === null) {
              return renderUnsafeImageText(token.text || '', href);
            }
            return `<img src="${escapeHtmlAttribute(sanitizedHref)}" alt="${escapeHtmlAttribute(token.text || '')}"${renderAttribute('title', token.title)}>`;
          }
        }
      });

      // Simple marked parse (escaping handled in renderers)
      function safeMarkedParse(text) {
        return marked.parse(text);
      }

      // Search input
      const searchInput = document.getElementById('tree-search');
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        forceTreeRerender();
      });

      // Filter buttons
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          filterMode = btn.dataset.filter;
          forceTreeRerender();
        });
      });

      // Sidebar toggle
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      const hamburger = document.getElementById('hamburger');
      const sidebarResizer = document.getElementById('sidebar-resizer');
      const SIDEBAR_WIDTH_STORAGE_KEY = 'gjc-share:v1:sidebar-width';
      const LEGACY_SIDEBAR_WIDTH_STORAGE_KEY = 'pi-share:v1:sidebar-width';
      const MIN_CONTENT_WIDTH = 320;

      function isMobileLayout() {
        return window.matchMedia('(max-width: 900px)').matches;
      }

      function getSidebarBounds() {
        const rootStyles = getComputedStyle(document.documentElement);
        const minWidth = parseFloat(rootStyles.getPropertyValue('--sidebar-min-width')) || 240;
        const maxWidth = parseFloat(rootStyles.getPropertyValue('--sidebar-max-width')) || 720;
        const viewportMaxWidth = window.innerWidth - MIN_CONTENT_WIDTH;
        return {
          minWidth,
          maxWidth: Math.max(minWidth, Math.min(maxWidth, viewportMaxWidth))
        };
      }

      function clampSidebarWidth(width) {
        const { minWidth, maxWidth } = getSidebarBounds();
        return Math.max(minWidth, Math.min(maxWidth, width));
      }

      function applySidebarWidth(width) {
        document.documentElement.style.setProperty('--sidebar-width', `${Math.round(clampSidebarWidth(width))}px`);
      }

      function loadSidebarWidth() {
        try {
          const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? localStorage.getItem(LEGACY_SIDEBAR_WIDTH_STORAGE_KEY);
          if (raw === null) return null;
          const width = Number(raw);
          return Number.isFinite(width) ? width : null;
        } catch {
          return null;
        }
      }

      function saveSidebarWidth(width) {
        try {
          localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(clampSidebarWidth(width))));
        } catch {
          // Ignore storage failures (e.g. private browsing restrictions)
        }
      }

      function setupSidebarResize() {
        const savedWidth = loadSidebarWidth();
        if (savedWidth !== null) {
          applySidebarWidth(savedWidth);
        }

        if (!sidebarResizer) return;

        let cleanupDrag = null;

        const stopDrag = (pointerId) => {
          if (cleanupDrag) {
            cleanupDrag(pointerId);
            cleanupDrag = null;
          }
        };

        sidebarResizer.addEventListener('pointerdown', (e) => {
          if (isMobileLayout()) return;

          e.preventDefault();
          const startX = e.clientX;
          const startWidth = sidebar.getBoundingClientRect().width;
          document.body.classList.add('sidebar-resizing');
          sidebarResizer.setPointerCapture?.(e.pointerId);

          const onPointerMove = (event) => {
            applySidebarWidth(startWidth + (event.clientX - startX));
          };

          cleanupDrag = (pointerIdToRelease) => {
            document.body.classList.remove('sidebar-resizing');
            sidebarResizer.releasePointerCapture?.(pointerIdToRelease);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerCancel);
            saveSidebarWidth(sidebar.getBoundingClientRect().width);
          };

          const onPointerUp = (event) => stopDrag(event.pointerId);
          const onPointerCancel = (event) => stopDrag(event.pointerId);

          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
          window.addEventListener('pointercancel', onPointerCancel);
        });

        sidebarResizer.addEventListener('dblclick', () => {
          if (isMobileLayout()) return;
          applySidebarWidth(400);
          saveSidebarWidth(400);
        });

        window.addEventListener('resize', () => {
          if (isMobileLayout()) return;
          applySidebarWidth(sidebar.getBoundingClientRect().width);
        });
      }

      setupSidebarResize();

      hamburger.addEventListener('click', () => {
        sidebar.classList.add('open');
        overlay.classList.add('open');
        hamburger.style.display = 'none';
      });

      const closeSidebar = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
        hamburger.style.display = '';
      };

      overlay.addEventListener('click', closeSidebar);
      document.getElementById('sidebar-close').addEventListener('click', closeSidebar);

      // Toggle states
      let thinkingExpanded = true;
      let toolOutputsExpanded = false;

      const toggleThinking = () => {
        thinkingExpanded = !thinkingExpanded;
        document.querySelectorAll('.thinking-text').forEach(el => {
          el.style.display = thinkingExpanded ? '' : 'none';
        });
        document.querySelectorAll('.thinking-collapsed').forEach(el => {
          el.style.display = thinkingExpanded ? 'none' : 'block';
        });
      };

      const toggleToolOutputs = () => {
        toolOutputsExpanded = !toolOutputsExpanded;
        document.querySelectorAll('.tool-output.expandable').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
        });
        document.querySelectorAll('.compaction').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
        });
      };

      // Keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          searchQuery = '';
          navigateTo(leafId, 'bottom');
        }
        if (e.ctrlKey && e.key === 't') {
          e.preventDefault();
          toggleThinking();
        }
        if (e.ctrlKey && e.key === 'o') {
          e.preventDefault();
          toggleToolOutputs();
        }
      });

      // Initial render
      // If URL has targetId, scroll to that specific message; otherwise stay at top
      if (leafId) {
        if (urlTargetId && byId.has(urlTargetId)) {
          navigateTo(leafId, 'target', urlTargetId);
        } else {
          navigateTo(leafId, 'none');
        }
      } else if (entries.length > 0) {
        // Fallback: use last entry if no leafId
        navigateTo(entries[entries.length - 1].id, 'none');
      }
    })();
