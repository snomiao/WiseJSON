/**
 * explorer/views/components/query-builder.ts
 * A dynamic UI component for building complex database filters.
 */

interface FilterRule {
  field: string;
  op: string;
  value: string;
}

class QueryBuilderComponent extends HTMLElement {
  private rules: FilterRule[] = [];
  private fields: string[] = [];
  private _rulesContainer!: HTMLElement;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 12px;
          border: 1px solid #d0d7de;
          border-radius: 8px;
          background-color: #ffffff;
        }
        .rules-container {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .rule {
          display: grid;
          grid-template-columns: 1.5fr 1fr 2fr auto;
          gap: 8px;
          align-items: center;
          padding: 8px;
          background-color: #f6f8fa;
          border-radius: 6px;
          border: 1px solid #e1e4e8;
        }
        select, input {
          width: 100%;
          padding: 6px 8px;
          border: 1px solid #d0d7de;
          border-radius: 5px;
          font-size: 13px;
          outline: none;
        }
        select:focus, input:focus { border-color: #0969da; box-shadow: 0 0 0 3px rgba(9, 105, 218, 0.1); }
        .remove-btn {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background-color: #cf222e;
          color: white;
          border: none;
          border-radius: 50%;
          cursor: pointer;
          font-weight: bold;
          font-size: 18px;
          transition: background 0.2s;
        }
        .remove-btn:hover { background-color: #a40e26; }
        .actions { margin-top: 12px; }
        .add-btn {
          padding: 6px 14px;
          background-color: #24292f;
          color: white;
          border: 1px solid rgba(27,31,35,0.15);
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 600;
        }
        .add-btn:hover { background-color: #1f2328; }
      </style>
      <div class="rules-container" id="rules-container"></div>
      <div class="actions">
          <button class="add-btn" id="add-rule-btn">+ Add Condition</button>
      </div>
    `;

    this._rulesContainer = this.shadowRoot!.getElementById('rules-container')!;
    this.shadowRoot!.getElementById('add-rule-btn')!.addEventListener('click', () => this.addRule());
  }

  /**
   * Sets the available fields for the dropdowns.
   */
  public setFields(fields: string[] = []): void {
    this.fields = fields;
    if (this.rules.length === 0) {
      this.addRule();
    } else {
      this.render();
    }
  }

  private addRule(data: FilterRule = { field: '', op: '$eq', value: '' }): void {
    this.rules.push(data);
    this.render();
  }

  private removeRule(index: number): void {
    this.rules.splice(index, 1);
    this.render();
    this._emitFilterChange();
  }

  private render(): void {
    this._rulesContainer.innerHTML = '';
    this.rules.forEach((rule, index) => {
      this._rulesContainer.appendChild(this._createRuleElement(rule, index));
    });
  }

  private _createRuleElement(rule: FilterRule, index: number): HTMLElement {
    const div = document.createElement('div');
    div.className = 'rule';

    // 1. Field Selection
    const fieldSelect = document.createElement('select');
    fieldSelect.innerHTML = `<option value="">-- Field --</option>` +
      this.fields.map(f => `<option value="${f}" ${rule.field === f ? 'selected' : ''}>${f}</option>`).join('');

    // 2. Operator Selection
    const operators: Record<string, string> = {
      '$eq': '=', '$ne': '!=', '$gt': '>', '$gte': '>=',
      '$lt': '<', '$lte': '<=', '$in': 'in', '$regex': 'regex', '$exists': 'exists'
    };
    const opSelect = document.createElement('select');
    opSelect.innerHTML = Object.entries(operators).map(([k, v]) =>
      `<option value="${k}" ${rule.op === k ? 'selected' : ''}>${v}</option>`).join('');

    // 3. Value Input
    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.placeholder = rule.op === '$exists' ? 'true/false' : 'Value...';
    valInput.value = rule.value;

    // 4. Delete Action
    const delBtn = document.createElement('button');
    delBtn.className = 'remove-btn';
    delBtn.innerHTML = '&times;';
    delBtn.onclick = () => this.removeRule(index);

    // Event Listeners
    fieldSelect.onchange = () => { this.rules[index].field = fieldSelect.value; this._emitFilterChange(); };
    opSelect.onchange = () => {
        this.rules[index].op = opSelect.value;
        this.render(); // Re-render to update placeholder
        this._emitFilterChange();
    };
    valInput.oninput = () => { this.rules[index].value = valInput.value; this._emitFilterChange(); };

    div.append(fieldSelect, opSelect, valInput, delBtn);
    return div;
  }

  private _emitFilterChange(): void {
    const filter: Record<string, any> = {};
    const validRules = this.rules.filter(r => r.field);

    validRules.forEach(rule => {
      let val: any = rule.value;

      // Type Casting Logic
      if (rule.op === '$exists') {
        val = val.toLowerCase() === 'true';
      } else if (rule.op === '$in') {
        val = val.split(',').map((s: string) => s.trim()).filter(Boolean);
      } else if (val.trim() !== '' && !isNaN(Number(val))) {
        val = Number(val);
      }

      // Construction of Query Object
      if (!filter[rule.field]) filter[rule.field] = {};

      if (rule.op === '$eq') {
        filter[rule.field] = val; // Direct equality
      } else {
        // Handle cases where multiple operators are on the same field
        if (typeof filter[rule.field] !== 'object') filter[rule.field] = { '$eq': filter[rule.field] };
        filter[rule.field][rule.op] = val;
      }
    });

    this.dispatchEvent(new CustomEvent('filter-changed', {
      bubbles: true,
      composed: true,
      detail: { filter }
    }));
  }
}



customElements.define('query-builder', QueryBuilderComponent);
