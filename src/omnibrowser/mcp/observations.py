"""Document-bound observation baselines and text deltas.

Adapts agent-browser's snapshot comparison contract (Apache-2.0).
Diffs are for content only; action targets must come from current inspection.
"""

import json
import uuid
from collections import OrderedDict


class Observations:
    def __init__(self):
        self.baselines = OrderedDict()

    def capture(self, target, page, scope, since=None):
        snapshot_id = f"obs-{uuid.uuid4().hex}"
        previous = self.baselines.pop(target, None)
        if len(json.dumps(page)) <= 512000:
            self.baselines[target] = (snapshot_id, dict(page), scope)
        while len(self.baselines) > 32:
            self.baselines.popitem(last=False)
        result = dict(page, snapshotId=snapshot_id, mode="full")
        if not since:
            return result
        if (
            not previous
            or previous[0] != since
            or previous[2] != scope
            or not page.get("documentId")
            or previous[1].get("documentId") != page["documentId"]
        ):
            return dict(result, baselineMissing=True)
        before, after = previous[1].get("text", ""), page.get("text", "")
        start, end_before, end_after = 0, len(before), len(after)
        while start < end_before and start < end_after and before[start] == after[start]:
            start += 1
        while (
            end_before > start
            and end_after > start
            and before[end_before - 1] == after[end_after - 1]
        ):
            end_before -= 1
            end_after -= 1
        result.pop("text", None)
        return dict(
            result,
            mode="delta",
            baselineId=since,
            changed=before != after
            or previous[1].get("title") != page.get("title")
            or previous[1].get("controls") != page.get("controls"),
            textPatch={
                "start": start,
                "deleteCount": end_before - start,
                "insert": after[start:end_after],
            },
        )
