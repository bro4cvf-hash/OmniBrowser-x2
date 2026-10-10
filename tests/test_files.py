import pytest

from omnibrowser.files import LocalFiles


def test_disabled_access(tmp_path):
    with pytest.raises(PermissionError, match="disabled"):
        LocalFiles([]).list_directory(str(tmp_path))


def test_read_and_pagination(tmp_path):
    (tmp_path / "notes.txt").write_text("one\ntwo\nthree", encoding="utf-8")
    files = LocalFiles([str(tmp_path)])
    result = files.read_file("notes.txt", max_lines=2)
    assert result["content"] == "one\ntwo"
    assert result["next_line"] == 3
    assert files.read_file("notes.txt", start_line=3)["content"] == "three"
    assert files.list_directory()["entries"][0]["name"] == "notes.txt"


def test_outside_root_and_sibling_prefix(tmp_path):
    root = tmp_path / "allowed"
    root.mkdir()
    sibling = tmp_path / "allowed-other"
    sibling.mkdir()
    (sibling / "secret.txt").write_text("secret")
    files = LocalFiles([str(root)])
    for path in ["../allowed-other/secret.txt", str(sibling / "secret.txt")]:
        with pytest.raises(PermissionError):
            files.read_file(path)


def test_symlink_escape(tmp_path):
    root = tmp_path / "allowed"
    root.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_text("secret")
    try:
        (root / "link.txt").symlink_to(outside)
    except OSError:
        pytest.skip("System does not permit symlink creation")
    files = LocalFiles([str(root)])
    with pytest.raises(PermissionError):
        files.read_file("link.txt")
    assert files.list_directory()["entries"] == []


def test_reject_binary_large_and_invalid_ranges(tmp_path):
    files = LocalFiles([str(tmp_path)])
    (tmp_path / "binary").write_bytes(b"hello\x00world")
    (tmp_path / "large").write_bytes(b"a" * (files.MAX_BYTES + 1))
    for path in ["binary", "large"]:
        with pytest.raises(ValueError):
            files.read_file(path)
    with pytest.raises(ValueError):
        files.read_file("binary", start_line=0)
    with pytest.raises(ValueError):
        files.list_directory(limit=0)


def test_search_and_batch_extraction(tmp_path):
    import zipfile

    nested = tmp_path / "applicant"
    nested.mkdir()
    (nested / "DETAILS.txt").write_text("Name: Alex\nCountry: Namibia", encoding="utf-8")
    (nested / "broken.docx").write_bytes(b"not a zip")
    with zipfile.ZipFile(nested / "profile.docx", "w") as archive:
        archive.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>Alex Smith</w:t></w:r></w:p></w:body></w:document>",
        )
    files = LocalFiles([str(tmp_path)])
    result = files.search(pattern="*.TXT")
    assert len(result["matches"]) == 1 and not result["truncated"]
    assert files.search(max_entries=1)["truncated"]
    result = files.read_many(
        [
            "applicant/profile.docx",
            "applicant/DETAILS.txt",
            "applicant/broken.docx",
            "../outside.txt",
        ]
    )
    assert result["results"][0]["content"] == "Alex Smith"
    assert "Country: Namibia" in result["results"][1]["content"]
    assert not result["results"][2]["ok"] and not result["results"][3]["ok"]


def test_document_batches_read_concurrently_in_source_order(tmp_path, monkeypatch):
    import threading

    files = LocalFiles([str(tmp_path)])
    barrier = threading.Barrier(4, timeout=3)

    def extract(path, max_lines):
        barrier.wait()
        if path == "broken":
            raise ValueError("Corrupt document")
        return {"path": path, "content": path, "max_lines": max_lines}

    monkeypatch.setattr(files, "extract", extract)
    result = files.read_many(["first", "broken", "third", "fourth"], max_lines=75)
    assert [item["path"] for item in result["results"]] == ["first", "broken", "third", "fourth"]
    assert [item["ok"] for item in result["results"]] == [True, False, True, True]
    assert result["results"][1]["error"] == "Corrupt document"
    assert result["results"][0]["max_lines"] == 75


def test_xlsx_extraction_and_expansion_limit(tmp_path):
    import zipfile

    with zipfile.ZipFile(tmp_path / "data.xlsx", "w") as archive:
        archive.writestr(
            "xl/worksheets/sheet1.xml",
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c>'
            '<c r="B1"><v>42</v></c></row></sheetData></worksheet>',
        )
    files = LocalFiles([str(tmp_path)])
    result = files.extract("data.xlsx")
    assert "A1=Name\tB1=42" in result["content"]
    assert result["warnings"]
    with pytest.raises(ValueError):
        files.read_many([])
    with pytest.raises(ValueError, match="max_lines must be between 1 and 1000"):
        files.read_many(["data.xlsx"], max_lines=0)
    with pytest.raises(ValueError, match="max_lines must be between 1 and 1000"):
        files.read_many(["data.xlsx"], max_lines=1001)


def test_pdf_text_and_scan_warning(tmp_path):
    pypdf = pytest.importorskip("pypdf")
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = pypdf.PdfWriter()
    page = writer.add_blank_page(width=300, height=300)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
    )
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 10 100 Td (Applicant: Alex) Tj ET")
    page[NameObject("/Contents")] = stream
    writer.add_blank_page(width=300, height=300)
    writer.write(tmp_path / "profile.pdf")
    result = LocalFiles([str(tmp_path)]).extract("profile.pdf")
    assert "Applicant: Alex" in result["content"]
    assert "Page 2 has no extractable text" in result["warnings"][0]


def test_corrupt_documents_raise_value_error(tmp_path):
    import zipfile

    # Bad XML in DOCX
    docx_path = tmp_path / "corrupt.docx"
    with zipfile.ZipFile(docx_path, "w") as archive:
        archive.writestr("word/document.xml", "<w:document><w:body><unclosed>")
    files = LocalFiles([str(tmp_path)])
    with pytest.raises(ValueError, match="Corrupt document"):
        files.extract("corrupt.docx")

    # Corrupt PDF
    (tmp_path / "corrupt.pdf").write_bytes(b"%PDF-1.4 corrupt header and content")
    with pytest.raises(ValueError, match="Corrupt document"):
        files.extract("corrupt.pdf")


def test_resolve_existence_oracle_nonexistent_outside(tmp_path):
    root = tmp_path / "allowed"
    root.mkdir()
    files = LocalFiles([str(root)])
    # Querying nonexistent file outside allowed root should raise PermissionError, NOT FileNotFoundError
    with pytest.raises(PermissionError):
        files.resolve("../nonexistent_secret.txt")


def test_content_truncation_cap(tmp_path):
    import zipfile

    # Create a docx with > 500,000 characters
    docx_path = tmp_path / "large.docx"
    large_text = "A" * 600_000
    with zipfile.ZipFile(docx_path, "w") as archive:
        archive.writestr(
            "word/document.xml",
            f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body><w:p><w:r><w:t>{large_text}</w:t></w:r></w:p></w:body></w:document>",
        )
    files = LocalFiles([str(tmp_path)])
    result = files.extract("large.docx")
    assert len(result["content"]) < 600_000
    assert "[Content truncated: exceeded 500,000 characters]" in result["content"]
    assert any("500,000 characters" in w for w in result["warnings"])
