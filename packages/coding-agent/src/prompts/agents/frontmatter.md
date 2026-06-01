---

name: {{jsonStringify name}}
description: {{jsonStringify description}}
{{#if spawns}}spawns: {{jsonStringify spawns}}
{{/if}}{{#if model}}model: {{jsonStringify model}}
{{/if}}{{#if thinkingLevel}}thinking-level: {{jsonStringify thinkingLevel}}
{{/if}}{{#if blocking}}blocking: true
{{/if}}{{#if hide}}hide: true
{{/if}}{{#if autoloadSkills}}autoloadSkills: {{jsonStringify autoloadSkills}}
{{/if}}{{#if forkContext}}forkContext: {{jsonStringify forkContext}}
{{/if}}---
{{body}}
