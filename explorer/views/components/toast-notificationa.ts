/**
 * explorer/views/components/toast-notifications.ts
 * A self-contained Web Component for displaying transient feedback messages.
 */

type ToastType = 'success' | 'error' | 'info';

class ToastNotificationsComponent extends HTMLElement {
    private container!: HTMLElement;

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
        this.shadowRoot!.innerHTML = `
            <style>
                :host {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    z-index: 10000;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    pointer-events: none; /* Allows clicks to pass through to the UI underneath */
                }
                .toast {
                    pointer-events: auto; /* Allows hover or clicks on the toast itself if needed */
                    min-width: 250px;
                    padding: 14px 24px;
                    border-radius: 8px;
                    color: #ffffff;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
                    font-size: 14px;
                    font-weight: 500;
                    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.12);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    animation:
                        slideIn 0.35s cubic-bezier(0.25, 1, 0.5, 1),
                        fadeOut 0.5s ease-in 2.5s forwards;
                }
                .toast.success { background-color: #238636; border-left: 5px solid #2ea44f; }
                .toast.error   { background-color: #da3633; border-left: 5px solid #f85149; }
                .toast.info    { background-color: #1f6feb; border-left: 5px solid #58a6ff; }

                @keyframes slideIn {
                    from { opacity: 0; transform: translateX(40px); }
                    to { opacity: 1; transform: translateX(0); }
                }
                @keyframes fadeOut {
                    from { opacity: 1; transform: translateY(0); }
                    to { opacity: 0; transform: translateY(-10px); }
                }
            </style>
            <div id="container"></div>
        `;
        this.container = this.shadowRoot!.getElementById('container')!;
    }

    /**
     * Triggers a toast notification.
     * @param message - The text to display to the user.
     * @param type - The semantic style of the toast.
     */
    public show(message: string, type: ToastType = 'info'): void {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        // Add text content
        const textSpan = document.createElement('span');
        textSpan.textContent = message;
        toast.appendChild(textSpan);

        this.container.appendChild(toast);

        // Remove from DOM exactly after the fadeOut animation finishes
        // (2.5s delay + 0.5s duration = 3000ms)
        setTimeout(() => {
            if (toast.parentNode) {
                this.container.removeChild(toast);
            }
        }, 3000);
    }
}

customElements.define('toast-notifications', ToastNotificationsComponent);
