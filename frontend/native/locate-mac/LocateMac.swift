// LocateMac — a tiny CoreLocation CLI helper for LocWarp's "locate this
// computer" feature on macOS.
//
// It requests one location fix via CLLocationManager (Wi-Fi / GPS
// positioning, typically 30–100 m in cities — far better than the ~5 km
// IP fallback) and prints a single line to stdout, then exits.
//
// The output format is DELIBERATELY identical to the Windows PowerShell
// helper (LOCATE_PS_SCRIPT in electron/main.js) so the Electron side can
// share one parser:
//
//   OK,<lat>,<lng>,<horizontalAccuracy>   success
//   DENIED                                permission denied / restricted
//   NODATA,status=<detail>                no fix within the deadline
//   ERROR,<message>                       unexpected failure
//
// First run pops the system location-permission dialog. In dev the host
// is this unsigned binary; in the packaged build the permission is bound
// to the .app via NSLocationUsageDescription (see electron-builder
// extendInfo in package.json).

import CoreLocation
import Foundation

// How long to wait for a fix before giving up. Mirrors the 15 s budget
// the PowerShell watcher uses; the Electron side kills us at 18 s as a
// hard backstop.
let kDeadlineSeconds: TimeInterval = 15.0

func emit(_ line: String) {
    print(line)
    // Ensure the line is flushed before we exit(0) from a delegate
    // callback — print() to a pipe can otherwise be buffered.
    fflush(stdout)
}

final class Locator: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var finished = false

    func start() {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        // requestLocation() delivers a single fix (or an error) — exactly
        // the one-shot semantics we want for a CLI.
        let status = currentAuthorization()
        switch status {
        case .denied, .restricted:
            finish("DENIED")
        case .notDetermined:
            // Triggers the permission prompt; the delegate callback below
            // re-drives once the user answers.
            manager.requestWhenInUseAuthorization()
            manager.startUpdatingLocation()
        default:
            manager.requestLocation()
        }
    }

    private func currentAuthorization() -> CLAuthorizationStatus {
        // authorizationStatus() is the instance property on modern macOS;
        // the class method is deprecated but the instance one needs the
        // manager to exist (it does).
        return manager.authorizationStatus
    }

    func finish(_ line: String) {
        if finished { return }
        finished = true
        manager.stopUpdatingLocation()
        emit(line)
        exit(0)
    }

    // MARK: CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .denied, .restricted:
            finish("DENIED")
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .notDetermined:
            break  // still waiting for the user to answer the prompt
        @unknown default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else {
            finish("NODATA,status=empty")
            return
        }
        let lat = loc.coordinate.latitude
        let lng = loc.coordinate.longitude
        let acc = loc.horizontalAccuracy
        // horizontalAccuracy < 0 means the fix is invalid.
        if acc < 0 {
            finish("NODATA,status=invalid_accuracy")
            return
        }
        finish("OK,\(lat),\(lng),\(acc)")
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if let clErr = error as? CLError {
            switch clErr.code {
            case .denied:
                finish("DENIED")
            case .locationUnknown:
                // Transient — CoreLocation couldn't get a fix yet. Report
                // as NODATA so the Electron side falls back to IP.
                finish("NODATA,status=location_unknown")
            default:
                finish("ERROR,\(clErr.code.rawValue):\(clErr.localizedDescription)")
            }
        } else {
            finish("ERROR,\(error.localizedDescription)")
        }
    }
}

// Location services must be enabled at the system level at all.
if !CLLocationManager.locationServicesEnabled() {
    emit("DENIED")
    exit(0)
}

let locator = Locator()
locator.start()

// Hard deadline: if no fix/permission answer arrives, bail with NODATA so
// the caller can fall back to IP geolocation.
DispatchQueue.main.asyncAfter(deadline: .now() + kDeadlineSeconds) {
    locator.finish("NODATA,status=timeout")
}

// CLLocationManager delivers callbacks on the main run loop.
RunLoop.main.run()
