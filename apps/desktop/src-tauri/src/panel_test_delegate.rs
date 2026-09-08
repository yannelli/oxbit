//! WDIO 1.4.0 installs an alert-only WKUIDelegate, swallowing window.open.
//! Preserve the application's delegate around that test plugin's ready hook.
//! Oxbit uses HTML dialogs; its native tests do not need JS-alert interception.
use objc2::{
    ffi::{objc_getAssociatedObject, objc_setAssociatedObject, OBJC_ASSOCIATION_RETAIN_NONATOMIC},
    rc::Retained,
    runtime::ProtocolObject,
};
use objc2_foundation::NSString;
use objc2_web_kit::{WKUIDelegate, WKWebView};
use tauri::{plugin::TauriPlugin, Wry};

static DELEGATE_KEY: u8 = 0;

pub fn hook(restore: bool) -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new(if restore {
        "panel-test-restore"
    } else {
        "panel-test-preserve"
    })
    .on_webview_ready(move |webview| {
        let _ = webview.with_webview(move |view| unsafe {
            // with_webview runs on the main thread. The associated object
            // retains the delegate until this WKWebView is deallocated.
            let wk = &*(view.inner() as *const WKWebView);
            let object = (wk as *const WKWebView).cast_mut().cast();
            let key = std::ptr::addr_of!(DELEGATE_KEY).cast();
            if restore {
                let saved = objc_getAssociatedObject(object, key);
                if !saved.is_null() {
                    wk.setUIDelegate(Some(&*saved.cast::<ProtocolObject<dyn WKUIDelegate>>()));
                }
            } else {
                // Related windows inherit a user-content controller. WDIO's
                // app-wide eval channel must be replaced, not registered twice.
                wk.configuration()
                    .userContentController()
                    .removeScriptMessageHandlerForName(&NSString::from_str("wdioEvalResult"));
                if let Some(delegate) = wk.UIDelegate() {
                    objc_setAssociatedObject(
                        object,
                        key,
                        Retained::as_ptr(&delegate).cast_mut().cast(),
                        OBJC_ASSOCIATION_RETAIN_NONATOMIC,
                    );
                }
            }
        });
    })
    .build()
}
