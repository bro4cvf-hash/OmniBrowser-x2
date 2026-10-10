/* Small, text-only Markdown renderer. Provider output is never inserted as HTML. */
window.OmniChatRenderer = {
  render(text, container) {
    container.replaceChildren();
    const inline = (parent, value) => {
      const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
      let offset = 0, match;
      while ((match = pattern.exec(value))) {
        parent.append(document.createTextNode(value.slice(offset, match.index)));
        const element = document.createElement(match[1] ? 'strong' : match[2] ? 'code' : 'a');
        element.textContent = match[1] || match[2] || match[3];
        if (match[4]) { element.href = match[4]; element.target = '_blank'; element.rel = 'noopener noreferrer'; }
        parent.append(element); offset = pattern.lastIndex;
      }
      parent.append(document.createTextNode(value.slice(offset)));
    };
    let list = null, code = null;
    for (const line of text.split('\n')) {
      if (line.trim().startsWith('```')) {
        if (code) code = null;
        else { code = document.createElement('pre'); container.append(code); }
        list = null; continue;
      }
      if (code) { code.append(document.createTextNode(line + '\n')); continue; }
      if (!line.trim()) { list = null; continue; }
      const bullet = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
      if (bullet) {
        if (!list) { list = document.createElement('ul'); container.append(list); }
        const item = document.createElement('li'); inline(item, bullet[1]); list.append(item); continue;
      }
      list = null;
      const heading = /^#{1,4}\s+(.+)$/.exec(line);
      const paragraph = document.createElement(heading ? 'h3' : 'p');
      inline(paragraph, heading ? heading[1] : line); container.append(paragraph);
    }
  }
};
