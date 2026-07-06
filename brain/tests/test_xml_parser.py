import pytest

from brain.llm import ToolParseError, parse_openai_tool_call, parse_xmlish_tool_call


def test_parse_json_tool_call():
    call = parse_xmlish_tool_call('<tool_call>{"name":"mine_block","arguments":{"type":"oak_log","count":4}}</tool_call>')
    assert call.tool == "mine_block"
    assert call.args == {"type": "oak_log", "count": 4}


def test_parse_tagged_tool_call():
    call = parse_xmlish_tool_call("<tool_call><name>chat</name><arguments>{\"message\":\"hi\"}</arguments></tool_call>")
    assert call.tool == "chat"
    assert call.args == {"message": "hi"}


def test_openai_multiple_tool_calls_error_is_specific():
    class Message:
        tool_calls = [object(), object()]
        content = ""

    with pytest.raises(ToolParseError, match="model returned 2 tool calls; expected exactly 1"):
        parse_openai_tool_call(Message())
