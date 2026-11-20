import Foundation
import JavaScriptCore

#if !os(iOS) || !targetEnvironment(simulator)
#error("This probe must run as an iOS simulator executable.")
#endif

guard CommandLine.arguments.count == 2, let context = JSContext() else { exit(2) }
let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
var failed = false
context.exceptionHandler = { _, _ in failed = true }
context.evaluateScript(source)
let deadline = Date().addingTimeInterval(5)
while Date() < deadline && !failed {
    if let result = context.objectForKeyedSubscript("__hangarProbeResult"), !result.isUndefined {
        let output = result.toString() ?? "{}"
        print(output)
        exit(output.contains("\"ok\":true") ? 0 : 1)
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
print("{\"ok\":false,\"error\":\"No result from iOS JavaScriptCore\"}")
exit(1)
