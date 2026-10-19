use super::files;
use std::path::{Path, PathBuf};

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn task_xml(profile: &str, sid: &str, executable: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>DeskMate background reminders and Agent checks ({})</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{}</UserId></LogonTrigger></Triggers><Principals><Principal id="User"><UserId>{}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="User"><Exec><Command>{}</Command><Arguments>--background-service</Arguments></Exec></Actions></Task>"#,
        xml(profile),
        xml(sid),
        xml(sid),
        xml(&executable.to_string_lossy())
    )
}

#[cfg(any(target_os = "macos", test))]
pub fn launch_agent(profile: &str, executable: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>{}.background</string><key>ProgramArguments</key><array><string>{}</string><string>--background-service</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>LimitLoadToSessionType</key><string>Aqua</string></dict></plist>"#,
        xml(profile),
        xml(&executable.to_string_lossy())
    )
}

pub fn start_registered(profile: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let output = atlas_process::command(files::system_tool("schtasks.exe"))
            .args(["/Run", "/TN", &task_name(profile, &files::user_sid()?)])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("Could not start the registered background task".into());
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let output = atlas_process::command("/bin/launchctl")
            .args([
                "kickstart",
                &format!("{}/{}.background", domain()?, profile),
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("Could not start the registered background LaunchAgent".into());
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Unsupported platform".into())
}

pub fn register(profile: &str, dir: &Path, executable: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let sid = files::user_sid()?;
        let path = dir.join("login-task.xml");
        let mut bytes = vec![0xff, 0xfe];
        for unit in task_xml(profile, &sid, executable).encode_utf16() {
            bytes.extend(unit.to_le_bytes());
        }
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        let result = atlas_process::command(files::system_tool("schtasks.exe"))
            .args(["/Create", "/F", "/TN", &task_name(profile, &sid), "/XML"])
            .arg(path)
            .output()
            .map_err(|e| e.to_string())?;
        if !result.status.success() {
            return Err(format!(
                "Could not register the current-user background login task (exit {})",
                result.status
            ));
        }
        crate::notifier::toast_activation::register(profile, executable)?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let path = agent_path(profile)?;
        let domain = domain()?;
        let service = format!("{domain}/{profile}.background");
        if atlas_process::command("/bin/launchctl")
            .args(["print", &service])
            .output()
            .map_err(|e| e.to_string())?
            .status
            .success()
        {
            // Do not replace a loaded job while its backend owns active Agent turns.
            if files::held(dir, "owner.lock") {
                return Ok(());
            }
            let output = atlas_process::command("/bin/launchctl")
                .args(["bootout", &service])
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(
                    "Could not unload the inactive background LaunchAgent before updating its path"
                        .into(),
                );
            }
        }
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&path, launch_agent(profile, executable)).map_err(|e| e.to_string())?;
        let output = atlas_process::command("/bin/launchctl")
            .arg("bootstrap")
            .arg(domain)
            .arg(path)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(
                "Could not load the current-user LaunchAgent; review Login Items permissions"
                    .into(),
            );
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Independent background execution is supported only on Windows and macOS".into())
}

pub fn unregister(profile: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let sid = files::user_sid()?;
        let name = task_name(profile, &sid);
        let query = atlas_process::command(files::system_tool("schtasks.exe"))
            .args(["/Query", "/TN", &name])
            .output()
            .map_err(|e| e.to_string())?;
        if query.status.success() {
            let output = atlas_process::command(files::system_tool("schtasks.exe"))
                .args(["/Delete", "/F", "/TN", &name])
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(
                    "Could not remove the background login task; the backend was not stopped"
                        .into(),
                );
            }
        } else {
            // A failed named query alone cannot distinguish absence from access failure.
            let listing = atlas_process::command(files::system_tool("schtasks.exe"))
                .args(["/Query", "/FO", "CSV", "/NH"])
                .output()
                .map_err(|e| e.to_string())?;
            let listed = String::from_utf8_lossy(&listing.stdout);
            let qualified = format!("\\{name}");
            if !listing.status.success()
                || listed
                    .lines()
                    .any(|line| line.split('"').nth(1) == Some(qualified.as_str()))
            {
                return Err("Cannot verify whether the background login task was removed; inspect Task Scheduler".into());
            }
        }
        let dir = files::directory(profile)?;
        if dir.join("login-task.xml").exists() {
            std::fs::remove_file(dir.join("login-task.xml")).map_err(|e| e.to_string())?;
        }
        crate::notifier::toast_activation::unregister(profile)?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let path = agent_path(profile)?;
        if path.exists() {
            let service = format!("{}/{}.background", domain()?, profile);
            let probe = atlas_process::command("/bin/launchctl")
                .args(["print", &service])
                .output()
                .map_err(|e| e.to_string())?;
            if probe.status.success() {
                let output = atlas_process::command("/bin/launchctl")
                    .args(["bootout", &service])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err("Could not unload the background LaunchAgent".into());
                }
            }
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Independent background execution is supported only on Windows and macOS".into())
}

#[cfg(windows)]
fn task_name(profile: &str, sid: &str) -> String {
    format!("DeskMate-{profile}-{sid}")
}
#[cfg(target_os = "macos")]
fn agent_path(profile: &str) -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|p| {
            p.join("Library/LaunchAgents")
                .join(format!("{profile}.background.plist"))
        })
        .ok_or("Home directory unavailable".into())
}
#[cfg(target_os = "macos")]
fn domain() -> Result<String, String> {
    let output = atlas_process::command("/usr/bin/id")
        .arg("-u")
        .output()
        .map_err(|e| e.to_string())?;
    let uid = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let uid = uid.trim().parse::<u32>().map_err(|e| e.to_string())?;
    Ok(format!("gui/{uid}"))
}

pub fn executable(_app: &tauri::AppHandle, dir: &Path) -> Result<PathBuf, String> {
    let desktop = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let contents = desktop
            .parent()
            .and_then(Path::parent)
            .ok_or("Invalid app bundle")?;
        let helper = contents
            .join("Library/LoginItems/DeskMate Background.app/Contents/MacOS/atlas-background");
        if !helper.is_file() {
            return Err("This build has no macOS background helper. Build an app bundle before enabling independent execution".into());
        }
        return Ok(helper);
    }
    #[cfg(windows)]
    {
        if !tauri::is_dev() {
            return Ok(desktop);
        }
        // A running dev service must not keep target/debug/atlas.exe build-locked.
        let runtime = dir.join("runtime").join(env!("ATLAS_BACKGROUND_BUILD"));
        std::fs::create_dir_all(&runtime).map_err(|e| e.to_string())?;
        let executable = runtime.join("atlas-background.exe");
        if !executable.exists() {
            std::fs::copy(desktop, &executable).map_err(|e| e.to_string())?;
        }
        return Ok(executable);
    }
    #[allow(unreachable_code)]
    {
        let _ = (dir, desktop);
        Err("Unsupported platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_login_task_never_requires_admin_password_or_device_wake() {
        let text = task_xml(
            "dev.atlas.ide",
            "S-1-5-21-1",
            Path::new("C:/A & B/atlas.exe"),
        );
        for expected in [
            "InteractiveToken",
            "LeastPrivilege",
            "IgnoreNew",
            "PT0S",
            "WakeToRun>false",
            "A &amp; B",
        ] {
            assert!(text.contains(expected));
        }
        assert!(!text.contains("Password"));
    }
    #[test]
    fn macos_agent_retains_arguments_and_restarts_only_failed_processes() {
        let text = launch_agent(
            "dev.atlas.ide.dev",
            Path::new("/Applications/A & B.app/helper"),
        );
        assert!(text.contains("A &amp; B.app/helper</string><string>--background-service"));
        assert!(text.contains("<key>SuccessfulExit</key><false/>"));
        assert!(text.contains("<integer>30</integer>"));
    }
}
