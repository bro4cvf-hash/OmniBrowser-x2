"""Compact, bounded accessibility snapshots from Chrome's computed tree."""


def compact_snapshot(nodes: list[dict], max_nodes: int) -> dict:
    """Keep semantic nodes and useful states, omitting raw values and name sources."""
    by_id = {node["nodeId"]: node for node in nodes}
    semantic = [node for node in nodes if not node.get("ignored", False)]
    selected = semantic[:max_nodes]
    selected_ids = {node["nodeId"] for node in selected}
    states = {"disabled", "checked", "expanded", "selected", "required", "focused", "level"}
    result = []
    text_truncated = False
    for node in selected:
        name = str(node.get("name", {}).get("value", ""))
        text_truncated |= len(name) > 500
        item = {
            "node_id": node["nodeId"],
            "role": str(node.get("role", {}).get("value", ""))[:100],
            "name": name[:500],
        }
        parent = node.get("parentId")
        seen = {node["nodeId"]}
        while parent in by_id and by_id[parent].get("ignored", False) and parent not in seen:
            seen.add(parent)
            parent = by_id[parent].get("parentId")
        item["parent_id"] = parent if parent in selected_ids and parent not in seen else None
        if "backendDOMNodeId" in node:
            item["backend_node_id"] = node["backendDOMNodeId"]
        item["states"] = {
            prop["name"]: prop.get("value", {}).get("value")
            for prop in node.get("properties", [])
            if prop.get("name") in states
            and isinstance(prop.get("value", {}).get("value"), (bool, int, float, str))
        }
        result.append(item)
    return {
        "nodes": result,
        "total_nodes": len(semantic),
        "truncated": len(semantic) > max_nodes,
        "text_truncated": text_truncated,
    }
