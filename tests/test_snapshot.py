from omnibrowser.mcp.snapshot import compact_snapshot


def test_snapshot_preserves_semantics_and_skips_ignored_ancestors():
    nodes = [
        {"nodeId": "1", "role": {"value": "RootWebArea"}},
        {"nodeId": "2", "parentId": "1", "ignored": True},
        {
            "nodeId": "3",
            "parentId": "2",
            "role": {"value": "checkbox"},
            "name": {"value": "Terms", "sources": [{"value": "private source"}]},
            "value": {"value": "private value"},
            "backendDOMNodeId": 42,
            "properties": [
                {"name": "checked", "value": {"value": "true"}},
                {"name": "labelledby", "value": {"value": "private source"}},
            ],
        },
    ]
    snapshot = compact_snapshot(nodes, 10)
    assert snapshot["total_nodes"] == 2
    assert not snapshot["truncated"]
    assert snapshot["nodes"][1] == {
        "node_id": "3",
        "parent_id": "1",
        "role": "checkbox",
        "name": "Terms",
        "backend_node_id": 42,
        "states": {"checked": "true"},
    }
    assert "private" not in str(snapshot)


def test_snapshot_bounds_output_and_does_not_leave_dangling_parents():
    nodes = [
        {"nodeId": "child", "parentId": "parent", "name": {"value": "x" * 501}},
        {"nodeId": "parent"},
    ]
    snapshot = compact_snapshot(nodes, 1)
    assert snapshot["truncated"] and snapshot["text_truncated"]
    assert len(snapshot["nodes"][0]["name"]) == 500
    assert snapshot["nodes"][0]["parent_id"] is None


def test_snapshot_handles_ignored_parent_cycle():
    nodes = [
        {"nodeId": "a", "parentId": "b", "ignored": True},
        {"nodeId": "b", "parentId": "a", "ignored": True},
        {"nodeId": "c", "parentId": "a"},
    ]
    assert compact_snapshot(nodes, 10)["nodes"][0]["parent_id"] is None
