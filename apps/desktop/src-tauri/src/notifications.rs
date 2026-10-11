//! Posts system notifications through UNUserNotificationCenter and sends each click to the
//! window that posted it. A click that launches Oxbit waits until that window watches.
use block2::RcBlock;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    AllocAnyThread,
};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSettings,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::{
    collections::BTreeMap,
    ptr::NonNull,
    sync::{mpsc, Mutex},
};
use tauri::{ipc::Channel, WebviewWindow};

const UNAVAILABLE: &str = "Native notifications need a bundled Oxbit app";

struct Watcher {
    window: WebviewWindow,
    channel: Channel<String>,
}

struct Clicks {
    watchers: BTreeMap<String, Watcher>,
    /// Window label and tag of a click that arrived before its window watched.
    pending: Option<(String, String)>,
}

static CLICKS: Mutex<Clicks> = Mutex::new(Clicks {
    watchers: BTreeMap::new(),
    pending: None,
});

define_class!(
    // SAFETY: NSObject has no subclassing requirements and `Delegate` does not implement Drop.
    #[unsafe(super = NSObject)]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            let default = unsafe { UNNotificationDefaultActionIdentifier };
            if response.actionIdentifier().isEqualToString(default) {
                let request = response.notification().request();
                if let Some(label) = request.content().targetContentIdentifier() {
                    clicked(label.to_string(), request.identifier().to_string());
                }
            }
            completion.call(());
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// UNUserNotificationCenter raises an exception in a process without a bundle identifier,
/// such as `cargo tauri dev` or the unbundled native-test binary.
pub fn available() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Sets the click delegate before launch finishes, so the click that launched Oxbit arrives.
pub fn install() -> bool {
    if !available() {
        return false;
    }
    let delegate = Delegate::new();
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly; it lives as long as the process.
    std::mem::forget(delegate);
    true
}

fn clicked(label: String, tag: String) {
    let target = {
        let mut clicks = CLICKS.lock().unwrap();
        match clicks.watchers.get(&label) {
            Some(watcher) => Some((watcher.window.clone(), watcher.channel.clone())),
            None => {
                clicks.pending = Some((label, tag.clone()));
                None
            }
        }
    };
    if let Some((window, channel)) = target {
        deliver(&window, &channel, tag);
    }
}

fn deliver(window: &WebviewWindow, channel: &Channel<String>, tag: String) {
    let _ = window.unminimize();
    let _ = window.set_focus();
    let _ = channel.send(tag);
}

fn permission_name(status: UNAuthorizationStatus) -> String {
    match status {
        UNAuthorizationStatus::Authorized
        | UNAuthorizationStatus::Provisional
        | UNAuthorizationStatus::Ephemeral => "granted",
        UNAuthorizationStatus::Denied => "denied",
        _ => "default",
    }
    .into()
}

fn read_permission(request: bool) -> Result<mpsc::Receiver<String>, String> {
    if !available() {
        return Err(UNAVAILABLE.into());
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let read = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        let _ = sender.send(permission_name(status));
    });
    let center = UNUserNotificationCenter::currentNotificationCenter();
    if request {
        let settings_center = center.clone();
        let requested = RcBlock::new(move |_: Bool, _: *mut NSError| {
            settings_center.getNotificationSettingsWithCompletionHandler(&read);
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &requested,
        );
    } else {
        center.getNotificationSettingsWithCompletionHandler(&read);
    }
    Ok(receiver)
}

async fn permission(request: bool) -> Result<String, String> {
    let receiver = read_permission(request)?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_notification_permission() -> Result<String, String> {
    permission(false).await
}

#[tauri::command]
pub async fn desktop_notification_request_permission() -> Result<String, String> {
    permission(true).await
}

fn post(
    label: &str,
    title: &str,
    body: Option<&str>,
    tag: Option<&str>,
) -> Result<mpsc::Receiver<Option<String>>, String> {
    if !available() {
        return Err(UNAVAILABLE.into());
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body.unwrap_or_default()));
    content.setTargetContentIdentifier(Some(&NSString::from_str(label)));
    // A tag replaces the earlier notification with the same tag, as Web Notification does.
    let identifier = tag.map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_owned);
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&identifier),
        &content,
        None,
    );
    let (sender, receiver) = mpsc::sync_channel(1);
    let added = RcBlock::new(move |error: *mut NSError| {
        let _ = sender
            .send(unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string()));
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&added));
    Ok(receiver)
}

#[tauri::command]
pub async fn desktop_notify(
    window: WebviewWindow,
    title: String,
    body: Option<String>,
    tag: Option<String>,
) -> Result<(), String> {
    let receiver = post(window.label(), &title, body.as_deref(), tag.as_deref())?;
    match tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|error| error.to_string())?
    {
        Ok(Some(error)) => Err(error),
        Ok(None) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn desktop_notification_watch(
    window: WebviewWindow,
    channel: Channel<String>,
) -> Result<(), String> {
    if !available() {
        return Err(UNAVAILABLE.into());
    }
    let label = window.label().to_owned();
    let pending = {
        let mut clicks = CLICKS.lock().unwrap();
        clicks.watchers.insert(
            label.clone(),
            Watcher {
                window: window.clone(),
                channel: channel.clone(),
            },
        );
        clicks.pending.take_if(|(target, _)| *target == label)
    };
    if let Some((_, tag)) = pending {
        deliver(&window, &channel, tag);
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_notification_unwatch(window: WebviewWindow, id: u32) {
    let mut clicks = CLICKS.lock().unwrap();
    if clicks
        .watchers
        .get(window.label())
        .is_some_and(|watcher| watcher.channel.id() == id)
    {
        clicks.watchers.remove(window.label());
    }
}
