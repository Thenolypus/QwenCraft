from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from openai import APIConnectionError, AsyncOpenAI

from .models import Config, Observation, ToolCall
from .prompts import build_user_prompt, system_prompt_with_history


class ToolParseError(ValueError):
    pass


class LLMConnectionError(ConnectionError):
    pass


def load_tools(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    return data["tools"]


def _json_loads_loose(text: str) -> Any:
    text = text.strip()
    text = re.sub(r",\s*([}\]])", r"\1", text)
    return json.loads(text)


def parse_xmlish_tool_call(text: str) -> ToolCall:
    """Parse Qwen/Ollama-style raw <tool_call> text into one ToolCall."""
    candidates = re.findall(r"<tool_call>\s*(.*?)\s*</tool_call>", text, flags=re.DOTALL | re.IGNORECASE)
    if not candidates:
        candidates = [text.strip()]
    parsed: list[ToolCall] = []
    for candidate in candidates:
        candidate = candidate.strip()
        try:
            data = _json_loads_loose(candidate)
            if isinstance(data, dict):
                name = data.get("name") or data.get("tool") or data.get("function", {}).get("name")
                args = data.get("arguments") or data.get("args") or data.get("function", {}).get("arguments") or {}
                if isinstance(args, str):
                    args = _json_loads_loose(args)
                if name:
                    parsed.append(ToolCall(tool=str(name), args=dict(args)))
                    continue
        except Exception:
            pass

        name_match = re.search(r"<(?:name|tool)>\s*([^<]+?)\s*</(?:name|tool)>", candidate, flags=re.IGNORECASE)
        args_match = re.search(r"<(?:arguments|args)>\s*(.*?)\s*</(?:arguments|args)>", candidate, flags=re.DOTALL | re.IGNORECASE)
        if name_match:
            args = _json_loads_loose(args_match.group(1)) if args_match else {}
            parsed.append(ToolCall(tool=name_match.group(1).strip(), args=dict(args)))

    if len(parsed) != 1:
        raise ToolParseError(f"expected exactly one tool call, found {len(parsed)}")
    return parsed[0]


def parse_openai_tool_call(message: Any) -> ToolCall:
    tool_calls = getattr(message, "tool_calls", None) or []
    if len(tool_calls) == 1:
        function = tool_calls[0].function
        args = _json_loads_loose(function.arguments or "{}")
        return ToolCall(tool=function.name, args=dict(args))
    if len(tool_calls) > 1:
        raise ToolParseError(f"model returned {len(tool_calls)} tool calls; expected exactly 1")
    content = getattr(message, "content", None) or ""
    return parse_xmlish_tool_call(content)


def _message_retry_content(message: Any) -> str:
    content = getattr(message, "content", None) or ""
    tool_calls = getattr(message, "tool_calls", None) or []
    if not tool_calls:
        return content

    serialized: list[Any] = []
    for tool_call in tool_calls:
        if hasattr(tool_call, "model_dump"):
            serialized.append(tool_call.model_dump(mode="json"))
            continue
        function = getattr(tool_call, "function", None)
        serialized.append(
            {
                "id": getattr(tool_call, "id", None),
                "type": getattr(tool_call, "type", None),
                "function": {
                    "name": getattr(function, "name", None),
                    "arguments": getattr(function, "arguments", None),
                },
            }
        )
    return f"{content}\nTool calls: {json.dumps(serialized, ensure_ascii=True, default=str)}".strip()


class LLMPlanner:
    def __init__(self, config: Config, tools: list[dict[str, Any]], history_summary: str = "") -> None:
        self.config = config
        self.tools = tools
        self.history_summary = history_summary
        self.client = AsyncOpenAI(base_url=config.llm_base_url, api_key=config.llm_api_key)
        self.validators = {
            tool["function"]["name"]: Draft202012Validator(tool["function"]["parameters"])
            for tool in tools
        }

    async def decide(
        self,
        observation: Observation,
        stage: str = "unknown",
        next_milestone: str = "unknown",
        hint: str = "",
    ) -> tuple[ToolCall, Any]:
        messages: list[dict[str, str]] = [
            {"role": "system", "content": system_prompt_with_history(self.history_summary)},
            {"role": "user", "content": build_user_prompt(observation, observation.memory.goal, stage, next_milestone, hint)},
        ]
        raw = await self._completion(messages)
        try:
            return self._parse_and_validate(raw.choices[0].message), raw.model_dump(mode="json")
        except Exception as first_error:
            messages.append({"role": "assistant", "content": _message_retry_content(raw.choices[0].message)})
            messages.append(
                {
                    "role": "user",
                    "content": f"Invalid tool call: {first_error}. Reply with exactly one valid tool call and no prose.",
                }
            )
            retry = await self._completion(messages)
            try:
                return self._parse_and_validate(retry.choices[0].message), retry.model_dump(mode="json")
            except Exception as second_error:
                fallback = {
                    "first_error": str(first_error),
                    "second_error": str(second_error),
                    "raw_retry": retry.model_dump(mode="json"),
                }
                return ToolCall(tool="stop", args={}), fallback

    def _parse_and_validate(self, message: Any) -> ToolCall:
        call = parse_openai_tool_call(message)
        validator = self.validators.get(call.tool)
        if validator is None:
            raise ToolParseError(f"unknown tool {call.tool}")
        errors = sorted(validator.iter_errors(call.args), key=lambda err: list(err.path))
        if errors:
            raise ToolParseError(f"{call.tool} args invalid: {errors[0].message}")
        return call

    async def summarize_events(self, events: list[str]) -> str:
        prompt = "Compress these Minecraft bot events into one short factual sentence:\n" + "\n".join(events)
        response = await self.client.chat.completions.create(
            model=self.config.llm_model,
            messages=[
                {"role": "system", "content": "Summarize event logs tersely."},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            extra_body={"chat_template_kwargs": {"enable_thinking": self.config.enable_thinking}},
        )
        return (response.choices[0].message.content or "").strip()

    async def compress_history(self, text: str) -> str:
        response = await self.client.chat.completions.create(
            model=self.config.llm_model,
            messages=[
                {"role": "system", "content": "Rewrite Minecraft agent memory tersely."},
                {
                    "role": "user",
                    "content": (
                        "Rewrite this Minecraft agent history in under 600 characters. "
                        "Keep goals achieved, important places, and unresolved problems.\n"
                        f"{text}"
                    ),
                },
            ],
            temperature=0,
            extra_body={"chat_template_kwargs": {"enable_thinking": self.config.enable_thinking}},
        )
        return (response.choices[0].message.content or "").strip()

    async def _completion(self, messages: list[dict[str, str]]) -> Any:
        try:
            return await self.client.chat.completions.create(
                model=self.config.llm_model,
                messages=messages,
                tools=self.tools,
                tool_choice="auto",
                temperature=self.config.temperature,
                extra_body={"chat_template_kwargs": {"enable_thinking": self.config.enable_thinking}},
            )
        except APIConnectionError as exc:
            raise LLMConnectionError(
                f"Could not connect to LLM endpoint {self.config.llm_base_url}. "
                "Start your OpenAI-compatible server first, or run the brain with --mock."
            ) from exc
