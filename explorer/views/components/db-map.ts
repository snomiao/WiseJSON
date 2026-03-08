/**
 * explorer/views/components/db-map.ts
 * Custom Web Component for visualizing the database schema as a draggable graph.
 */

interface NodePosition {
  x: number;
  y: number;
}

interface GraphData {
  collections: Array<{
    name: string;
    docCount: number;
    fields: Array<{
      name: string;
      isIndexed: boolean;
      isUnique?: boolean;
      types: string[];
    }>;
  }>;
  links: Array<{
    source: string;
    target: string;
  }>;
}

class DbMapComponent extends HTMLElement {
  private graphData: GraphData | null = null;
  private isDragging = false;
  private draggedNode: HTMLElement | null = null;
  private offsetX = 0;
  private offsetY = 0;
  private storageKey = 'wisejson-db-map-positions';

  // Shadow DOM elements
  private _canvas!: HTMLElement;
  private _svgLinks!: SVGSVGElement;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 500px;
          border: 1px solid #d1d5da;
          border-radius: 6px;
          background-color: #f6f8fa;
          overflow: auto;
          position: relative;
        }
        .canvas {
          position: absolute;
          top: 0;
          left: 0;
          width: 3000px;
          height: 2000px;
        }
        .collection-node {
          position: absolute;
          background-color: white;
          border: 1px solid #586069;
          border-radius: 4px;
          padding: 10px;
          min-width: 220px;
          font-family: 'Segoe UI', Tahoma, sans-serif;
          font-size: 13px;
          cursor: grab;
          box-shadow: 0 1px 5px rgba(27,31,35,.15);
          transition: box-shadow 0.2s;
          user-select: none;
          z-index: 10;
        }
        .collection-node:active { cursor: grabbing; z-index: 1000; }
        .collection-node:hover { box-shadow: 0 4px 10px rgba(27,31,35,.2); }
        .collection-node.selected { border-color: #0366d6; border-width: 2px; }
        .collection-node h3 {
          margin: 0 0 10px 0;
          padding-bottom: 5px;
          border-bottom: 1px solid #e1e4e8;
          font-size: 14px;
          color: #0366d6;
        }
        .field-list { margin: 0; padding: 0; list-style: none; }
        .field-item { white-space: nowrap; margin-bottom: 2px; }
        .field-item.indexed { font-weight: bold; color: #22863a; }
        .field-item .icon { display: inline-block; width: 18px; }
        .svg-links { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
        .svg-links path { stroke: #adb5bd; stroke-width: 2; fill: none; opacity: 0.6; }
      </style>
      <div class="canvas" id="canvas">
        <svg class="svg-links" id="svg-links"></svg>
      </div>
    `;
    this._canvas = this.shadowRoot!.getElementById('canvas')!;
    this._svgLinks = this.shadowRoot!.getElementById('svg-links') as unknown as SVGSVGElement;

    this._canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
  }

  /**
   * Renders the visual graph from the provided data.
   */
  public render(graphData: GraphData): void {
    this.graphData = graphData;
    const fragment = document.createDocumentFragment();
    if (!graphData.collections) return;

    const positions = this._initializeNodePositions(graphData.collections);

    graphData.collections.forEach(col => {
      const pos = positions[col.name];
      const nodeEl = this._createCollectionNode(col, pos);
      fragment.appendChild(nodeEl);
    });

    // Clear canvas while keeping the SVG layer
    this._canvas.innerHTML = '';
    this._canvas.appendChild(this._svgLinks);
    this._canvas.appendChild(fragment);

    // Initial draw of Bezier links
    requestAnimationFrame(() => this._drawLinks());
  }

  private _initializeNodePositions(collections: GraphData['collections']): Record<string, NodePosition> {
    const saved = this._loadPositions();
    const finalPositions: Record<string, NodePosition> = {};
    const PADDING = 60;
    const NODE_WIDTH = 240;
    const COLS = Math.floor(this.offsetWidth / (NODE_WIDTH + PADDING)) || 1;

    collections.forEach((col, i) => {
      if (saved && saved[col.name]) {
        finalPositions[col.name] = saved[col.name];
      } else {
        const row = Math.floor(i / COLS);
        const colIdx = i % COLS;
        finalPositions[col.name] = {
          x: PADDING + colIdx * (NODE_WIDTH + PADDING),
          y: PADDING + row * (180 + PADDING),
        };
      }
    });
    return finalPositions;
  }

  private _createCollectionNode(col: GraphData['collections'][0], pos: NodePosition): HTMLElement {
    const nodeEl = document.createElement('div');
    nodeEl.className = 'collection-node';
    nodeEl.style.left = `${pos.x}px`;
    nodeEl.style.top = `${pos.y}px`;
    nodeEl.dataset["collectionName"] = col.name;

    const fieldsHtml = col.fields.map(field => `
      <li class="field-item ${field.isIndexed ? 'indexed' : ''}">
        <span class="icon">${field.isIndexed ? (field.isUnique ? '🔑' : '⚡') : '•'}</span>
        ${field.name}: <i style="color: #6a737d">${field.types.join('|')}</i>
      </li>
    `).join('');

    nodeEl.innerHTML = `<h3>${col.name}</h3><ul class="field-list">${fieldsHtml}</ul>`;
    return nodeEl;
  }

  private _drawLinks(): void {
    if (!this.graphData?.links) return;
    this._svgLinks.innerHTML = '';

    this.graphData.links.forEach(link => {
      const src = this.shadowRoot!.querySelector(`[data-collection-name="${link.source}"]`) as HTMLElement;
      const target = this.shadowRoot!.querySelector(`[data-collection-name="${link.target}"]`) as HTMLElement;
      if (!src || !target) return;

      const sX = parseFloat(src.style.left) + src.offsetWidth;
      const sY = parseFloat(src.style.top) + src.offsetHeight / 2;
      const eX = parseFloat(target.style.left);
      const eY = parseFloat(target.style.top) + target.offsetHeight / 2;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const cp1 = sX + 40;
      const cp2 = eX - 40;
      path.setAttribute('d', `M ${sX} ${sY} C ${cp1} ${sY}, ${cp2} ${eY}, ${eX} ${eY}`);
      this._svgLinks.appendChild(path);
    });
  }

  // --- Drag & Drop Engine ---

  private _onMouseDown(e: MouseEvent): void {
    const node = (e.target as HTMLElement).closest('.collection-node') as HTMLElement;
    if (!node) return;

    this.draggedNode = node;
    this.isDragging = true;
    this.offsetX = e.clientX - node.offsetLeft;
    this.offsetY = e.clientY - node.offsetTop;

    const onMove = (ev: MouseEvent) => {
      if (!this.isDragging || !this.draggedNode) return;
      const x = ev.clientX - this.offsetX;
      const y = ev.clientY - this.offsetY;

      this.draggedNode.style.left = `${Math.max(0, x)}px`;
      this.draggedNode.style.top = `${Math.max(0, y)}px`;
      this._drawLinks();
    };

    const onUp = () => {
      this.isDragging = false;
      document.removeEventListener('mousemove', onMove);
      this._savePositions();
      this._selectNode(this.draggedNode!);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
  }

  private _selectNode(node: HTMLElement): void {
    const name = node.dataset["collectionName"]!;
    this.shadowRoot!.querySelectorAll('.collection-node').forEach(n => n.classList.remove('selected'));
    node.classList.add('selected');

    this.dispatchEvent(new CustomEvent('collection-selected', {
      detail: { collectionName: name }, bubbles: true, composed: true
    }));
  }

  private _savePositions(): void {
    const pos: Record<string, NodePosition> = {};
    this.shadowRoot!.querySelectorAll('.collection-node').forEach(node => {
      const n = node as HTMLElement;
      pos[n.dataset["collectionName"]!] = { x: parseFloat(n.style.left), y: parseFloat(n.style.top) };
    });
    localStorage.setItem(this.storageKey, JSON.stringify(pos));
  }

  private _loadPositions(): Record<string, NodePosition> | null {
    try {
      return JSON.parse(localStorage.getItem(this.storageKey) || 'null');
    } catch { return null; }
  }
}

customElements.define('db-map', DbMapComponent);
