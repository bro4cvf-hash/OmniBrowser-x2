"""Bounded, read-only access to explicitly configured local folders."""

import fnmatch
import os
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from xml.etree import ElementTree as ET

# Share one bounded pool across batches, rather than starting twenty readers per call.
_DOCUMENT_READ_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="document-read")


class LocalFiles:
    MAX_BYTES = 2 * 1024 * 1024

    def __init__(self, roots: list[str]):
        self.roots = [Path(root).expanduser().resolve(strict=True) for root in roots]
        if any(not root.is_dir() for root in self.roots):
            raise ValueError("Every allowed root must be a directory")

    def resolve(self, path: str) -> Path:
        if not self.roots:
            raise PermissionError("File access is disabled. Start with --allow-dir <folder>.")
        candidate = Path(path).expanduser()
        if not candidate.is_absolute():
            candidate = self.roots[0] / candidate
        # Lexical containment check before resolving to prevent existence oracle
        candidate_norm = candidate.resolve(strict=False)
        if not any(
            candidate_norm == root or candidate_norm.is_relative_to(root) for root in self.roots
        ):
            raise PermissionError("Path is outside the allowed folders")
        candidate = candidate.resolve(strict=True)
        if not any(candidate.is_relative_to(root) for root in self.roots):
            raise PermissionError("Path is outside the allowed folders")
        return candidate

    def list_directory(self, path: str = ".", offset: int = 0, limit: int = 200) -> dict:
        if offset < 0 or not 1 <= limit <= 500:
            raise ValueError("offset must be nonnegative; limit must be between 1 and 500")
        directory = self.resolve(path)
        if not directory.is_dir():
            raise ValueError("Path must be a directory")
        children = sorted(directory.iterdir(), key=lambda item: item.name.casefold())
        entries = []
        for child in children[offset : offset + limit]:
            try:
                resolved = self.resolve(str(child))
                entries.append(
                    {
                        "name": child.name,
                        "path": str(child),
                        "directory": resolved.is_dir(),
                        "size": resolved.stat().st_size if resolved.is_file() else None,
                    }
                )
            except (OSError, ValueError):
                # Hide inaccessible entries and links leading outside the allowed roots.
                continue
        next_offset = offset + limit if offset + limit < len(children) else None
        return {"path": str(directory), "entries": entries, "next_offset": next_offset}

    def read_file(self, path: str, start_line: int = 1, max_lines: int = 200) -> dict:
        if start_line < 1 or not 1 <= max_lines <= 1000:
            raise ValueError("start_line must be positive; max_lines must be between 1 and 1000")
        file = self.resolve(path)
        if not file.is_file():
            raise ValueError("Path must be a regular file")
        with file.open("rb") as stream:
            data = stream.read(self.MAX_BYTES + 1)
        if len(data) > self.MAX_BYTES:
            raise ValueError("File exceeds the 2 MiB read limit")
        if b"\x00" in data:
            raise ValueError("Binary files are not supported; select a UTF-8 text file")
        try:
            lines = data.decode("utf-8-sig").splitlines()
        except UnicodeDecodeError as error:
            raise ValueError("File must be UTF-8 text") from error
        end = start_line - 1 + max_lines
        return {
            "path": str(file),
            "start_line": start_line,
            "total_lines": len(lines),
            "content": "\n".join(lines[start_line - 1 : end]),
            "next_line": end + 1 if end < len(lines) else None,
        }

    def search(
        self, path: str = ".", pattern: str = "*", limit: int = 100, max_entries: int = 10000
    ) -> dict:
        """Bounded recursive filename search; never follow directory links."""
        if not 1 <= limit <= 500 or not 1 <= max_entries <= 100000:
            raise ValueError("Invalid search limits")
        directory = self.resolve(path)
        if not directory.is_dir():
            raise ValueError("Path must be a directory")
        matches, scanned, errors = [], 0, []

        def onerror(error):
            if len(errors) < 20:
                errors.append(str(error))

        for base, dirs, names in os.walk(directory, followlinks=False, onerror=onerror):
            scanned += 1
            if scanned >= max_entries:
                return {
                    "matches": matches,
                    "scanned": scanned,
                    "truncated": True,
                    "errors": errors[:20],
                }
            safe_dirs = []
            for name in sorted(dirs):
                try:
                    child = Path(base) / name
                    if not child.is_symlink():
                        self.resolve(str(child))
                        safe_dirs.append(name)
                except (OSError, ValueError) as error:
                    onerror(error)
            dirs[:] = safe_dirs
            for name in sorted(names):
                scanned += 1
                try:
                    candidate = self.resolve(str(Path(base) / name))
                    if candidate.is_file() and fnmatch.fnmatch(name.casefold(), pattern.casefold()):
                        matches.append({"path": str(candidate), "size": candidate.stat().st_size})
                except (OSError, ValueError) as error:
                    onerror(error)
                if len(matches) >= limit or scanned >= max_entries:
                    return {
                        "matches": matches,
                        "scanned": scanned,
                        "truncated": True,
                        "errors": errors[:20],
                    }
        return {"matches": matches, "scanned": scanned, "truncated": False, "errors": errors[:20]}

    def extract(self, path: str, start_line: int = 1, max_lines: int = 200) -> dict:
        """Extract text from PDF/DOCX/XLSX or read UTF-8. No OCR or formula evaluation."""
        if start_line < 1 or not 1 <= max_lines <= 1000:
            raise ValueError("Invalid line range")
        file = self.resolve(path)
        suffix = file.suffix.lower()
        if suffix not in {".pdf", ".docx", ".xlsx"}:
            return self.read_file(path, start_line, max_lines)
        if not file.is_file() or file.stat().st_size > 20 * 1024 * 1024:
            raise ValueError("Document must be a regular file up to 20 MiB")
        warnings = []
        try:
            import pypdf.errors

            pdf_errors = (pypdf.errors.PdfReadError,)
        except ImportError:
            pdf_errors = ()

        try:
            if suffix == ".pdf":
                try:
                    from pypdf import PdfReader
                except ImportError as error:
                    raise ValueError(
                        'Install document support: pip install "omnibrowser[documents]"'
                    ) from error
                reader = PdfReader(file)
                if reader.is_encrypted:
                    raise ValueError("Encrypted PDFs are not supported")
                if len(reader.pages) > 200:
                    raise ValueError("PDF exceeds the 200 page limit")
                parts = []
                for number, page in enumerate(reader.pages, 1):
                    value = page.extract_text() or ""
                    parts.append(f"[Page {number}]\n{value}")
                    if not value.strip():
                        warnings.append(f"Page {number} has no extractable text; OCR may be needed")
                    text = "\n".join(parts)
            else:
                with zipfile.ZipFile(file) as archive:
                    if sum(info.file_size for info in archive.infolist()) > 40 * 1024 * 1024:
                        raise ValueError("Expanded document exceeds 40 MiB")

                    def xml(name):
                        data = archive.read(name)
                        if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
                            raise ValueError("XML entities are not supported")
                        return ET.fromstring(data)

                    if suffix == ".docx":
                        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
                        body = xml("word/document.xml")
                        paragraphs = []
                        for paragraph in body.findall(".//w:p", ns):
                            paragraphs.append(
                                "".join(
                                    node.text or ""
                                    if node.tag.endswith("}t")
                                    else "\t"
                                    if node.tag.endswith("}tab")
                                    else "\n"
                                    for node in paragraph.iter()
                                    if node.tag
                                    in {f"{{{ns['w']}}}t", f"{{{ns['w']}}}tab", f"{{{ns['w']}}}br"}
                                )
                            )
                        text = "\n".join(paragraphs)
                        warnings.append(
                            "Body paragraphs and tables only; headers and images excluded"
                        )
                    else:
                        ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
                        strings = []
                        if "xl/sharedStrings.xml" in archive.namelist():
                            strings = [
                                "".join(n.text or "" for n in item.findall(".//s:t", ns))
                                for item in xml("xl/sharedStrings.xml").findall("s:si", ns)
                            ]
                        parts = []
                        for name in sorted(archive.namelist()):
                            if not name.startswith("xl/worksheets/sheet") or not name.endswith(
                                ".xml"
                            ):
                                continue
                            parts.append(f"[Worksheet {name}]")
                            for row in xml(name).findall(".//s:row", ns):
                                cells = []
                                for cell in row.findall("s:c", ns):
                                    value = cell.findtext("s:v", default="", namespaces=ns)
                                    if cell.get("t") == "s":
                                        value = strings[int(value)]
                                    elif cell.get("t") == "inlineStr":
                                        value = "".join(
                                            n.text or "" for n in cell.findall(".//s:t", ns)
                                        )
                                    cells.append(f"{cell.get('r', '?')}={value}")
                                parts.append("\t".join(cells))
                        text = "\n".join(parts)
                        warnings.append(
                            "Raw cell values; dates may be serials, formulas use cached values"
                        )
        except (ValueError, TypeError):
            raise
        except (
            zipfile.BadZipFile,
            ET.ParseError,
            IndexError,
            KeyError,
            *pdf_errors,
            Exception,
        ) as err:
            raise ValueError(f"Corrupt document: {err}") from err
        if len(text) > 2 * 1024 * 1024:
            raise ValueError("Extracted text exceeds 2 MiB")
        lines = text.splitlines()
        end = start_line - 1 + max_lines
        content = "\n".join(lines[start_line - 1 : end])
        max_chars = 500_000
        if len(content) > max_chars:
            content = content[:max_chars] + "\n[Content truncated: exceeded 500,000 characters]"
            warnings.append("Extracted content exceeded 500,000 characters and was truncated")
        return {
            "path": str(file),
            "format": suffix[1:],
            "start_line": start_line,
            "total_lines": len(lines),
            "content": content,
            "next_line": end + 1 if end < len(lines) else None,
            "warnings": warnings,
        }

    def read_many(self, paths: list[str], max_lines: int = 100) -> dict:
        if not isinstance(paths, list) or not 1 <= len(paths) <= 20:
            raise ValueError("Provide between 1 and 20 paths")
        if not 1 <= max_lines <= 1000:
            raise ValueError("max_lines must be between 1 and 1000")

        def read(path):
            try:
                return {"ok": True, **self.extract(path, max_lines=max_lines)}
            except Exception as error:
                # A corrupt document must not prevent reading the remaining sources.
                return {"path": path, "ok": False, "error": str(error)}

        return {"results": list(_DOCUMENT_READ_POOL.map(read, paths))}
