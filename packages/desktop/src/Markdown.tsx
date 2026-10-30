import { decodeHTMLStrict } from "entities";
import { Marked, type MarkedToken, type Token, type Tokens } from "marked";
import { Fragment, type ReactNode, useState } from "react";
import { t } from "./i18n";

const markdown = new Marked({ gfm: true, breaks: false });

function safeLink(href: string): boolean {
	// Reject control characters and whitespace rather than letting the browser normalize them into a scheme.
	if (/[\s\u0000-\u001f\u007f\\]/u.test(href)) return false;
	if (href.startsWith("#")) return true;
	return /^(?:https?:\/\/|mailto:)/iu.test(href);
}

function CodeBlock({ token, code }: { token: Tokens.Code; code: string }) {
	const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
	const language = token.lang?.split(/\s+/u)[0] || t("support.markdownPlainText");
	async function copy() {
		try {
			await navigator.clipboard.writeText(code);
			setStatus("copied");
		} catch {
			setStatus("failed");
		}
	}
	return (
		<div className="markdown-code-block">
			<div className="markdown-code-header">
				<span className="markdown-code-language">{language}</span>
				<button type="button" className="markdown-code-copy" onClick={copy}>
					{t("support.markdownCopyCode")}
				</button>
				<span className="markdown-code-status" role="status">
					{status === "copied"
						? t("support.markdownCopied")
						: status === "failed"
							? t("support.markdownCopyFailed")
							: ""}
				</span>
			</div>
			<pre className="markdown-code-content" style={{ overflow: "auto", maxHeight: "24rem" }}>
				<code>{code}</code>
			</pre>
		</div>
	);
}

function renderTokens(tokens: Token[]): ReactNode {
	return tokens.map((token, index) => <Fragment key={index}>{renderToken(token)}</Fragment>);
}

function renderToken(input: Token): ReactNode {
	// This parser has no token extensions, so its output is the built-in token union.
	const token = input as MarkedToken;
	switch (token.type) {
		case "space":
		case "def":
			return null;
		case "paragraph":
			return <p>{renderTokens(token.tokens)}</p>;
		case "heading": {
			const content = renderTokens(token.tokens);
			switch (token.depth) {
				case 1:
					return <h1>{content}</h1>;
				case 2:
					return <h2>{content}</h2>;
				case 3:
					return <h3>{content}</h3>;
				case 4:
					return <h4>{content}</h4>;
				case 5:
					return <h5>{content}</h5>;
				default:
					return <h6>{content}</h6>;
			}
		}
		case "blockquote":
			return <blockquote>{renderTokens(token.tokens)}</blockquote>;
		case "list": {
			const items = token.items.map((item: Tokens.ListItem, index: number) => (
				<li key={index}>
					{item.task && (
						<input
							type="checkbox"
							checked={!!item.checked}
							disabled
							aria-label={item.checked ? t("support.markdownTaskDone") : t("support.markdownTaskOpen")}
						/>
					)}
					{renderTokens(item.tokens)}
				</li>
			));
			return token.ordered ? (
				<ol start={token.start === "" ? undefined : token.start}>{items}</ol>
			) : (
				<ul>{items}</ul>
			);
		}
		case "table":
			return (
				<div className="markdown-table-wrap" style={{ overflowX: "auto" }}>
					<table>
						<thead>
							<tr>
								{token.header.map((cell: Tokens.TableCell, index: number) => (
									<th key={index} scope="col" style={{ textAlign: cell.align ?? undefined }}>
										{renderTokens(cell.tokens)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{token.rows.map((row: Tokens.TableCell[], index: number) => (
								<tr key={index}>
									{row.map((cell, cellIndex) => (
										<td key={cellIndex} style={{ textAlign: cell.align ?? undefined }}>
											{renderTokens(cell.tokens)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "code":
			return <CodeBlock key={token.text} token={token} code={token.text} />;
		case "hr":
			return <hr />;
		case "strong":
			return <strong>{renderTokens(token.tokens)}</strong>;
		case "em":
			return <em>{renderTokens(token.tokens)}</em>;
		case "del":
			return <del>{renderTokens(token.tokens)}</del>;
		case "codespan":
			return <code>{token.text}</code>;
		case "br":
			return <br />;
		case "link":
			return safeLink(token.href) ? (
				<a
					href={token.href}
					title={token.title ?? undefined}
					target={token.href.startsWith("#") ? undefined : "_blank"}
					rel={token.href.startsWith("#") ? undefined : "noopener noreferrer"}
				>
					{renderTokens(token.tokens)}
				</a>
			) : (
				renderTokens(token.tokens)
			);
		case "image":
			return <span className="markdown-image-alt">{decodeHTMLStrict(token.text)}</span>;
		case "html":
			return token.raw;
		case "escape":
			return token.text;
		case "text":
			return token.tokens ? renderTokens(token.tokens) : decodeHTMLStrict(token.text);
		default:
			return token.raw;
	}
}

export function Markdown({ text }: { text: string }) {
	// Copy the same logical code the parser renders, including nested containers.
	return <div className="markdown">{renderTokens(markdown.lexer(text))}</div>;
}
