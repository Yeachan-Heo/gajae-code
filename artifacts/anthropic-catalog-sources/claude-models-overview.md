# Models overview

Claude is a family of state-of-the-art large language models developed by Anthropic. This guide introduces the available models and compares their performance.

---

## Choosing a model

If you're unsure which model to use, start with **Claude Opus 5** for complex agentic coding and enterprise work. For workloads that need the highest available capability, use [Claude Fable 5](#claude-fable-5-and-claude-mythos-5).

All current Claude models support text and image input, text output, multilingual capabilities, and vision. Models are available through the Claude API, [Amazon Bedrock](/docs/en/build-with-claude/claude-in-amazon-bedrock), [Claude Platform on AWS](/docs/en/build-with-claude/claude-platform-on-aws), [Google Cloud](/docs/en/build-with-claude/claude-on-vertex-ai), and [Microsoft Foundry](/docs/en/build-with-claude/claude-in-microsoft-foundry).

Once you've picked a model, [learn how to make your first API call](/docs/en/get-started).

### Claude Fable 5 and Claude Mythos 5

Claude Fable 5 (`claude-fable-5`) is Anthropic's most capable widely released model. Claude Mythos 5 (`claude-mythos-5`) shares Claude Fable 5's specs and pricing and joins the invitation-only Claude Mythos Preview (`claude-mythos-preview`) within [Project Glasswing](https://anthropic.com/glasswing). See [Introducing Claude Fable 5 and Claude Mythos 5](/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5) for launch details and API changes.

Claude Fable 5 is generally available on the Claude API, Amazon Bedrock, Claude Platform on AWS, Google Cloud, and Microsoft Foundry beginning June 9, 2026. Claude Mythos 5 is not generally available: it is offered in limited availability to approved customers in [Project Glasswing](https://anthropic.com/glasswing), beginning the same day. For access, contact your Anthropic, AWS, or Google Cloud account team.

### Latest models comparison

| Feature                                                                                            | Claude Fable 5                                                                                                                                                                                                                                                                                 | Claude Opus 5                                                                        | Claude Sonnet 5                                                                      | Claude Haiku 4.5                                                                       |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Description**                                                                                    | Next-generation intelligence for long-running agents                                                                                                                                                                                                                                           | For complex agentic coding and enterprise work                                       | The best combination of speed and intelligence                                       | The fastest model with near-frontier intelligence                                      |
| **Claude API ID**                                                                                  | claude-fable-5                                                                                                                                                                                                                                                                                 | claude-opus-5                                                                        | claude-sonnet-5                                                                      | claude-haiku-4-5-20251001                                                              |
| **Claude API alias**                                                                               | claude-fable-5                                                                                                                                                                                                                                                                                 | claude-opus-5                                                                        | claude-sonnet-5                                                                      | claude-haiku-4-5                                                                       |
| **AWS Bedrock ID**                                                                                 | anthropic.claude-fable-53                                                                                                                                                                                                                                                                      | anthropic.claude-opus-53                                                             | anthropic.claude-sonnet-53                                                           | anthropic.claude-haiku-4-5-20251001-v1:0                                               |
| **Google Cloud ID**                                                                                | claude-fable-5                                                                                                                                                                                                                                                                                 | claude-opus-5                                                                        | claude-sonnet-5                                                                      | claude-haiku-4-5\@20251001                                                             |
| **Pricing**1                                                                                       | $10 / input MTok $50 / output MTok                                                                                                                                                                                                                                                             | $5 / input MTok $25 / output MTok                                                    | $3 / input MTok $15 / output MTok4                                                   | $1 / input MTok $5 / output MTok                                                       |
| **[Extended thinking (`thinking.type: "enabled"`)](/docs/en/build-with-claude/extended-thinking)** | No                                                                                                                                                                                                                                                                                             | No                                                                                   | No                                                                                   | Yes                                                                                    |
| **[Adaptive thinking](/docs/en/build-with-claude/thinking)**                                       | Yes (always on)                                                                                                                                                                                                                                                                                | Yes                                                                                  | Yes                                                                                  | No                                                                                     |
| **Comparative latency**                                                                            | Slower                                                                                                                                                                                                                                                                                         | Moderate                                                                             | Fast                                                                                 | Fastest                                                                                |
| **Context window**                                                                                 | <Tooltip tooltipContent="~555k words \ ~2.5M unicode characters. Claude Fable 5 uses the tokenizer introduced with Claude Opus 4.7; compared to models before Claude Opus 4.7, the same text produces roughly 30% more tokens. The exact increase depends on the content.">1M tokens</Tooltip> | <Tooltip tooltipContent="~555k words \ ~2.5M unicode characters">1M tokens</Tooltip> | <Tooltip tooltipContent="~555k words \ ~2.5M unicode characters">1M tokens</Tooltip> | <Tooltip tooltipContent="~150k words \ ~680k unicode characters">200k tokens</Tooltip> |
| **Max output**                                                                                     | 128k tokens                                                                                                                                                                                                                                                                                    | 128k tokens                                                                          | 128k tokens                                                                          | 64k tokens                                                                             |
| **Reliable knowledge cutoff**                                                                      | Jan 20262                                                                                                                                                                                                                                                                                      | May 20262                                                                            | Jan 20262                                                                            | Feb 2025                                                                               |
| **Training data cutoff**                                                                           | Jan 2026                                                                                                                                                                                                                                                                                       | May 2026                                                                             | Jan 2026                                                                             | Jul 2025                                                                               |

*1 See [Pricing](/docs/en/about-claude/pricing) for complete pricing information including Batch API discounts and prompt caching rates.*

*2 **Reliable knowledge cutoff** indicates the date through which a model's knowledge is most extensive and reliable. **Training data cutoff** is the broader date range of training data used. For more information, see [Anthropic's Transparency Hub](https://www.anthropic.com/transparency).*

*3 Claude Fable 5, Claude Opus 5, and Claude Sonnet 5 are available on Bedrock through [Claude in Amazon Bedrock](/docs/en/build-with-claude/claude-in-amazon-bedrock) (the Messages-API Bedrock endpoint).*

*4 Introductory pricing of $2 / $10 per MTok applies to Claude Sonnet 5 through August 31, 2026. See [Pricing](/docs/en/about-claude/pricing#claude-sonnet-5-introductory-pricing).*

<Info>
  Claude Mythos 5 and Claude Mythos Preview are offered separately for defensive cybersecurity workflows as part of [Project Glasswing](https://anthropic.com/glasswing). Access is invitation-only and there is no self-serve sign-up.
</Info>

<Note>
  Every Claude model ID is a pinned snapshot. Models with a date in the ID (for example, 

  `20250929`

  ) are fixed to that specific release. Starting with the Claude 4.6 generation, model IDs use a dateless format that is also a pinned snapshot, not an evergreen pointer. For models before the 4.6 generation, entries in the Claude API alias column are convenience pointers that resolve to a dated model ID. For details on the naming convention and how versioning works, see 

  [Model IDs and versioning](/docs/en/about-claude/models/model-ids-and-versions)

  .
</Note>

<Note>
  Starting with 

  **Claude Sonnet 4.5 and all subsequent models**

   (including Claude Sonnet 4.6), Bedrock offers two endpoint types: 

  **global endpoints**

   (dynamic routing for maximum availability) and 

  **regional endpoints**

   (guaranteed data routing through specific geographic regions). Google Cloud offers three endpoint types: global endpoints, 

  **multi-region endpoints**

   (dynamic routing within a geographic area), and regional endpoints. For more information, see 

  [Cloud platform pricing](/docs/en/about-claude/pricing#cloud-platform-pricing)

  .
</Note>

<Note>
  **Claude Platform on AWS**

   uses the same model IDs as the Claude API (for example, 

  `claude-opus-4-6`

  ), not Bedrock-style IDs. Model lifecycle on Claude Platform on AWS follows Anthropic's first-party 

  [Model deprecations](/docs/en/about-claude/model-deprecations)

  , not Bedrock's. See 

  [Available models](/docs/en/build-with-claude/claude-platform-on-aws#available-models)

   for the model list.
</Note>

<Tip>
  You can query model capabilities and token limits programmatically with the [Models API](/docs/en/api/models/list). The response includes `max_input_tokens`, `max_tokens`, and a `capabilities` object for every available model.
</Tip>

<Note>
  On Claude Opus 4.8, the `effort` parameter defaults to `high` on all surfaces, including the Claude API, Claude Code, and claude.ai. On Claude Opus 5 and Claude Sonnet 5, it defaults to `high` on the Claude API and Claude Code. Set `effort` explicitly to use a different level. See [Effort](/docs/en/build-with-claude/effort) for guidance on choosing a level.
</Note>

<Note>
  The Max output values in the table apply to the synchronous Messages API. On the [Message Batches API](/docs/en/build-with-claude/batch-processing#extended-output-beta), Claude Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5, and Sonnet 4.6 support up to 300k output tokens by using the `output-300k-2026-03-24` beta header.
</Note>

<AccordionGroup>
  <Accordion title="Legacy models">
    The following models are still available. Consider migrating to current models for improved performance:

    | Feature                                                                                            | Claude Opus 4.8                                                                      | Claude Opus 4.7                                                                                                      | Claude Opus 4.6                                                                      | Claude Sonnet 4.6                                                                    | Claude Sonnet 4.5                                                                      | Claude Opus 4.5                                                                        | Claude Opus 4.1 (deprecated)                                                           |
    | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
    | **Claude API ID**                                                                                  | claude-opus-4-8                                                                      | claude-opus-4-7                                                                                                      | claude-opus-4-6                                                                      | claude-sonnet-4-6                                                                    | claude-sonnet-4-5-20250929                                                             | claude-opus-4-5-20251101                                                               | claude-opus-4-1-20250805                                                               |
    | **Claude API alias**                                                                               | claude-opus-4-8                                                                      | claude-opus-4-7                                                                                                      | claude-opus-4-6                                                                      | claude-sonnet-4-6                                                                    | claude-sonnet-4-5                                                                      | claude-opus-4-5                                                                        | claude-opus-4-1                                                                        |
    | **AWS Bedrock ID**                                                                                 | anthropic.claude-opus-4-86                                                           | anthropic.claude-opus-4-76                                                                                           | anthropic.claude-opus-4-6-v1                                                         | anthropic.claude-sonnet-4-6                                                          | anthropic.claude-sonnet-4-5-20250929-v1:0                                              | anthropic.claude-opus-4-5-20251101-v1:0                                                | anthropic.claude-opus-4-1-20250805-v1:0                                                |
    | **Google Cloud ID**                                                                                | claude-opus-4-8                                                                      | claude-opus-4-7                                                                                                      | claude-opus-4-6                                                                      | claude-sonnet-4-6                                                                    | claude-sonnet-4-5\@20250929                                                            | claude-opus-4-5\@20251101                                                              | claude-opus-4-1\@20250805                                                              |
    | **Pricing**                                                                                        | $5 / input MTok $25 / output MTok                                                    | $5 / input MTok $25 / output MTok                                                                                    | $5 / input MTok $25 / output MTok                                                    | $3 / input MTok $15 / output MTok                                                    | $3 / input MTok $15 / output MTok                                                      | $5 / input MTok $25 / output MTok                                                      | $15 / input MTok $75 / output MTok                                                     |
    | **[Extended thinking (`thinking.type: "enabled"`)](/docs/en/build-with-claude/extended-thinking)** | No                                                                                   | No                                                                                                                   | Yes (deprecated)                                                                     | Yes (deprecated)                                                                     | Yes                                                                                    | Yes                                                                                    | Yes                                                                                    |
    | **[Adaptive thinking](/docs/en/build-with-claude/thinking)**                                       | Yes                                                                                  | Yes                                                                                                                  | Yes                                                                                  | Yes                                                                                  | No                                                                                     | No                                                                                     | No                                                                                     |
    | **Comparative latency**                                                                            | Moderate                                                                             | Moderate                                                                                                             | Moderate                                                                             | Fast                                                                                 | Fast                                                                                   | Moderate                                                                               | Moderate                                                                               |
    | **Context window**                                                                                 | <Tooltip tooltipContent="~555k words \ ~2.5M unicode characters">1M tokens</Tooltip> | <Tooltip tooltipContent="~555k words \ ~2.5M unicode characters (Opus 4.7 uses a new tokenizer)">1M tokens</Tooltip> | <Tooltip tooltipContent="~750k words \ ~3.4M unicode characters">1M tokens</Tooltip> | <Tooltip tooltipContent="~750k words \ ~3.4M unicode characters">1M tokens</Tooltip> | <Tooltip tooltipContent="~150k words \ ~680k unicode characters">200k tokens</Tooltip> | <Tooltip tooltipContent="~150k words \ ~680k unicode characters">200k tokens</Tooltip> | <Tooltip tooltipContent="~150k words \ ~680k unicode characters">200k tokens</Tooltip> |
    | **Max output**                                                                                     | 128k tokens                                                                          | 128k tokens                                                                                                          | 128k tokens                                                                          | 128k tokens                                                                          | 64k tokens                                                                             | 64k tokens                                                                             | 32k tokens                                                                             |
    | **Reliable knowledge cutoff**                                                                      | Jan 20265                                                                            | Jan 20265                                                                                                            | May 20255                                                                            | Aug 20255                                                                            | Jan 20255                                                                              | May 20255                                                                              | Jan 20255                                                                              |
    | **Training data cutoff**                                                                           | Jan 2026                                                                             | Jan 2026                                                                                                             | Aug 2025                                                                             | Jan 2026                                                                             | Jul 2025                                                                               | Aug 2025                                                                               | Mar 2025                                                                               |

    <Warning>
      Claude Opus 4.1 (`claude-opus-4-1-20250805`) is deprecated and will be retired on August 5, 2026. Migrate to [Claude Opus 5](/docs/en/about-claude/models/migration-guide#migrating-from-claude-opus-4-8-to-claude-opus-5) before the retirement date.

      See [model deprecations](/docs/en/about-claude/model-deprecations) for details.
    </Warning>

    *5 **Reliable knowledge cutoff** indicates the date through which a model's knowledge is most extensive and reliable. **Training data cutoff** is the broader date range of training data used.*

    *6 Claude Opus 4.8 and Claude Opus 4.7 are available on Bedrock through [Claude in Amazon Bedrock](/docs/en/build-with-claude/claude-in-amazon-bedrock) (the Messages-API Bedrock endpoint).*
  </Accordion>
</AccordionGroup>

## Prompt and output performance

Current Claude models excel in:

* **Performance:** Top-tier results in reasoning, coding, multilingual tasks, long-context handling, honesty, and image processing. See [Prompting best practices](/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) for general and model-specific prompting guidance.

* **Engaging responses:** Claude models are ideal for applications that require rich, human-like interactions.

  * If you prefer more concise responses, you can adjust your prompts to guide the model toward the desired output length. Refer to the [prompt engineering guides](/docs/en/build-with-claude/prompt-engineering) for details.
  * For prompting best practices, see [Prompting best practices](/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices).

* **Output quality:** When migrating from a previous model generation, you may notice larger improvements in overall performance.

## Migrating to Claude Opus 5

If you're currently using Claude Opus 4.8 or earlier Claude models, see [Migrating to Claude Opus 5](/docs/en/about-claude/models/migration-guide#migrating-from-claude-opus-4-8-to-claude-opus-5).

## Get started with Claude

If you're ready to start exploring what Claude can do for you, dive in! Whether you're a developer looking to integrate Claude into your applications or a user wanting to experience the power of AI firsthand, the following resources can help.

<Note>
  Looking to chat with Claude? Visit 

  [claude.ai](https://claude.ai)

  !
</Note>

<CardGroup cols={3}>
  <Card title="Intro to Claude" icon="check" href="/docs/en/intro">
    Explore Claude's capabilities and development flow.
  </Card>

  <Card title="Quickstart" icon="lightning" href="/docs/en/get-started">
    Learn how to make your first API call in minutes.
  </Card>

  <Card title="Claude Console" icon="code" href="/">
    Craft and test powerful prompts directly in your browser.
  </Card>
</CardGroup>

If you have any questions or need assistance, don't hesitate to reach out to the [support team](https://support.claude.com/) or consult the [Discord community](https://www.anthropic.com/discord).
