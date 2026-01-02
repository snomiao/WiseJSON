/* eslint-disable no-useless-escape */
/**
 * explorer/views/components/json-viewer.ts
 * A syntax-highlighting viewer for JSON objects and raw strings.
 */

class JsonViewerComponent extends HTMLElement {
  private _contentElement!: HTMLPreElement;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes(): string[] {
    return ['value'];
  }

  connectedCallback() {
    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
        }
        pre {
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
          font-size: 13px;
          line-height: 1.5;
          background-color: #f6f8fa;
          border: 1px solid #d1d5da;
          border-radius: 6px;
          padding: 16px;
          margin: 0;
          box-sizing: border-box;
          white-space: pre-wrap;
          word-wrap: break-word;
          color: #24292e;
          max-height: 500px;
          overflow-y: auto;
          tab-size: 2;
        }
        /* Syntax Colors inspired by GitHub/PrismJS */
        .key     { color: #005cc5; font-weight: 600; } /* Blue */
        .string  { color: #032f62; } /* Dark Blue */
        .number  { color: #d73a49; } /* Red */
        .boolean { color: #56239a; } /* Purple */
        .null    { color: #6a737d; font-style: italic; } /* Grey */
      </style>
      <pre id="content"></pre>
    `;
    this._contentElement = this.shadowRoot!.getElementById('content') as HTMLPreElement;

    // Initial render if value attribute is present
    const initialValue = this.getAttribute('value');
    if (initialValue) this.render(initialValue);
  }

  /**
   * Public setter to update the displayed data.
   * Automatically stringifies objects or displays raw input.
   */
  set value(data: any) {
    const valueString = (typeof data === 'object' && data !== null)
      ? JSON.stringify(data, null, 2)
      : String(data);
    this.setAttribute('value', valueString);
  }

  get value(): string | null {
    return this.getAttribute('value');
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string) {
    if (name === 'value' && this._contentElement) {
      this.render(newValue);
    }
  }

  private render(jsonString: string): void {
    if (!jsonString) {
      this._contentElement.textContent = '';
      return;
    }

    try {
      // Validate and reformat
      const jsonObj = JSON.parse(jsonString);
      const formatted = JSON.stringify(jsonObj, null, 2);
      this._contentElement.innerHTML = this._syntaxHighlight(formatted);
    } catch (e) {
      // Fallback for non-JSON strings
      this._contentElement.textContent = jsonString;
    }
  }

  /**
   * Uses regex to wrap JSON tokens in styled <span> elements.
   */
  private _syntaxHighlight(json: string): string {
    // Escape HTML characters
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const regex = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;

    return json.replace(regex, (match) => {
      let cls = 'number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'key';
        } else {
          cls = 'string';
        }
      } else if (/true|false/.test(match)) {
        cls = 'boolean';
      } else if (/null/.test(match)) {
        cls = 'null';
      }
      return `<span class="${cls}">${match}</span>`;
    });
  }
}



customElements.define('json-viewer', JsonViewerComponent);
