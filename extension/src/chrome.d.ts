/**
 * The sliver of the `chrome.*` extension API this extension actually calls.
 * Not a dependency on `@types/chrome` — that package is not installed here,
 * and this extension's whole surface is small enough that typing it by hand
 * is less risk than adding a devDependency this repo's size limits don't
 * have room to review.
 */
declare namespace chrome {
  namespace tabs {
    interface Tab {
      id?: number;
    }
    function create(properties: { url: string }): Promise<Tab>;
  }

  namespace action {
    interface ClickedListener {
      addListener(callback: (tab: tabs.Tab) => void): void;
    }
    const onClicked: ClickedListener;
    function setBadgeText(details: { tabId: number; text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void>;
    function setTitle(details: { tabId: number; title: string }): Promise<void>;
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number;
    }
    interface InjectionResult<T> {
      result: T;
    }
    function executeScript<Args extends unknown[], T>(injection: {
      target: InjectionTarget;
      files?: string[];
      func?: (...args: Args) => T;
      args?: Args;
    }): Promise<Array<InjectionResult<T>>>;
  }
}
