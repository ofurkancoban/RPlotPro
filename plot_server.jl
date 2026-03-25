module RPlotPro

using Base64
using Random
using Dates

export start_plot_viewer, stop_plot_viewer, RPlotProDisplay

# Helper functions to retrieve modules in the latest world age.
# Crucial for Julia 1.12+ where modules themselves may be too "new" for static access.
get_json() = Base.invokelatest(getfield, Main, :JSON)
get_http() = Base.invokelatest(getfield, Main, :HTTP)

# Helper to ensure packages are available
function ensure_packages()
    pkgs = ["HTTP", "JSON"]
    to_install = String[]
    
    # Check what's already loaded or available
    for pkg in pkgs
        try
            Base.eval(Main, :(using $(Symbol(pkg))))
        catch
            push!(to_install, pkg)
        end
    end
    
    if !isempty(to_install)
        @info "R Plot Pro: Installing missing dependencies $(join(to_install, ", ")). This may take a minute..."
        try
            # Use eval to handle import dynamically since it's not allowed at non-top-level scope
            Base.eval(Main, :(import Pkg))
            Base.invokelatest(Main.Pkg.add, to_install)
            for pkg in to_install
                Base.eval(Main, :(using $(Symbol(pkg))))
            end
        catch e
            @error "R Plot Pro: Failed to install dependencies" exception=(e, catch_backtrace())
            return false
        end
    end
    return true
end

# State variables
const clients = Dict{String, Any}()
const plots = []
const raw_plots = Dict{String, Vector{UInt8}}()
const recordings = Dict{String, Any}()
const client_dims = Ref((width=800, height=600))
server_task = Ref{Union{Nothing, Task}}(nothing)
last_plot = Ref{Any}(nothing)

# Display implementation
struct RPlotProDisplay <: AbstractDisplay end

function Base.display(d::RPlotProDisplay, x)
    if is_plot_object(x)
        capture_and_send(x)
        
        # Aggressive Re-stacking: Make sure we stay at the top for the next plot
        ensure_display_at_top()
        
        # return nothing to indicate we've handled the display.
        return nothing
    else
        throw(MethodError(display, (d, x)))
    end
end

# MIME-specific display methods - CRITICAL for Makie inline display detection.
# Makie checks if any display in the stack can handle MIME"image/png" or MIME"image/svg+xml".
# Without these, Makie says "no display can show the plot" and opens a window instead.
function Base.display(d::RPlotProDisplay, m::MIME"image/png", x)
    capture_and_send(x)
    ensure_display_at_top()
    return nothing
end

function Base.display(d::RPlotProDisplay, m::MIME"image/svg+xml", x)
    capture_and_send(x)
    ensure_display_at_top()
    return nothing
end

# Tell Julia our display is capable of showing these MIME types
Base.displayable(d::RPlotProDisplay, ::MIME"image/png") = true
Base.displayable(d::RPlotProDisplay, ::MIME"image/svg+xml") = true

function is_plot_object(x)
    # Heuristically check if it looks like a plot object
    t = string(typeof(x))
    
    # 1. Name based check (covers most common ones)
    if occursin("Plot", t) || occursin("Figure", t) || occursin("Scene", t) || occursin("Chart", t) || occursin("Makie", t) || occursin("Layout", t)
        return true
    end
    
    # 2. MIME based check (more robust)
    # Check if it supports SVG or PNG - most plotting libs do
    is_svg = Base.invokelatest(showable, MIME("image/svg+xml"), x)
    is_png = Base.invokelatest(showable, MIME("image/png"), x)
    
    if is_svg || is_png
        return true
    end
    
    return false
end

function capture_and_send(plot_obj)
    try
        last_plot[] = plot_obj
        
        # Capture SVG
        io = IOBuffer()
        # Try SVG first
        try
            Base.invokelatest(show, io, MIME("image/svg+xml"), plot_obj)
        catch e
            # Fallback to PNG
            Base.invokelatest(show, io, MIME("image/png"), plot_obj)
        end
        
        raw_data = take!(io)
        if length(raw_data) < 100
             return
        end
        
        id = string(floor(Int, datetime2unix(now()) * 1000))
        format = occursin("svg", String(raw_data[1:min(100, end)])) ? "svg" : "png"
        
        metadata = Dict(
            "id" => id,
            "timestamp" => Dates.format(now(), "HH:MM:SS"),
            "format" => format
        )
        
        # Manage history (keep last 100)
        push!(plots, metadata)
        if length(plots) > 100
            old = popfirst!(plots)
            delete!(recordings, old["id"])
            delete!(raw_plots, old["id"])
        end
        
        recordings[id] = plot_obj
        raw_plots[id] = raw_data
        
        broadcast_plot(raw_data, metadata)
    catch e
        @warn "R Plot Pro: Error capturing plot" exception=(e, catch_backtrace())
    end
end

function broadcast_plot(bin_payload, metadata)
    for (id, ws) in clients
        send_binary(ws, "new_plot", bin_payload, metadata)
    end
end

function send_binary(ws, type, bin_payload, metadata=Dict())
    metadata["type"] = type
    meta_json = Base.invokelatest(get_json().json, metadata)
    meta_bytes = Vector{UInt8}(meta_json)
    meta_len = UInt32(length(meta_bytes))
    
    # Pack: [Uint32 LEN (big endian)][JSON META][PAYLOAD]
    io = IOBuffer()
    write(io, hton(meta_len))
    write(io, meta_bytes)
    write(io, bin_payload)
    
    try
        Base.invokelatest(get_http().WebSockets.send, ws, take!(io))
    catch
        # Client likely disconnected
    end
end

function handle_ws_message(ws, msg)
    data = Base.invokelatest(get_json().parse, String(msg))
    
    if data["type"] == "ping"
        Base.invokelatest(get_http().WebSockets.send, ws, Base.invokelatest(get_json().json, Dict("type" => "pong")))
    elseif data["type"] == "get_plots"
        Base.invokelatest(get_http().WebSockets.send, ws, Base.invokelatest(get_json().json, Dict("type" => "plot_list", "plots" => plots)))
    elseif data["type"] == "request_binary"
        pid = string(data["plot_id"])
        if haskey(raw_plots, pid)
            # Find format
            fmt = "svg"
            for p in plots
                if p["id"] == pid
                    fmt = p["format"]
                    break
                end
            end
            send_binary(ws, "update_plot", raw_plots[pid], Dict("id" => pid, "format" => fmt))
        end
    elseif data["type"] == "clear_all"
        empty!(plots)
        empty!(recordings)
        empty!(raw_plots)
        last_plot[] = nothing
    elseif data["type"] == "resize"
        new_w = Int(data["width"])
        new_h = Int(data["height"])
        
        # Prevent infinite loops: only re-render if dimensions changed meaningfully (> 5px)
        old_w = client_dims[].width
        old_h = client_dims[].height
        
        if abs(new_w - old_w) > 5 || abs(new_h - old_h) > 5
            client_dims[] = (width=new_w, height=new_h)
            
            # Re-render if we have the plot object
            pid = get(data, "plot_id", nothing)
            target = isnothing(pid) ? last_plot[] : get(recordings, string(pid), nothing)
            
            if !isnothing(target)
                capture_and_send(target)
            end
        end
    end
end

function start_plot_viewer(port=nothing)
    if !ensure_packages()
        @error "R Plot Pro: Could not start viewer due to missing dependencies."
        return
    end
    
    # Force Disable VS Code's internal plot pane
    ENV["JULIA_VSCODE_DISPLAY_PLOTS"] = "false"
    
    # Shared config logic
    config_path = get(ENV, "VSCODE_R_PLOT_CONFIG", "")
    if isempty(config_path)
        config_path = joinpath(pwd(), ".r_plot_config.json")
    end
    
    # Suppress external GR/GKS windows
    ENV["GKSwstype"] = "100"
    
    if isnothing(port)
        port = rand(10000:30000)
    end
    
    # Write port to config
    open(config_path, "w") do f
        Base.invokelatest(get_json().print, f, Dict("port" => port))
    end
    
    
    # Register display and ensure it's at the top
    ensure_display_at_top()
    
    # Run server in background
    server_task[] = @async begin
        try
            # Suppress HTTP.jl's "Listening on:" log
            Base.CoreLogging.with_logger(Base.CoreLogging.NullLogger()) do
                Base.invokelatest(get_http().WebSockets.listen, ws -> begin
                id = string(rand())
                clients[id] = ws
                
                # Send current plots if any
                if !isempty(plots)
                    Base.invokelatest(get_http().WebSockets.send, ws, Base.invokelatest(get_json().json, Dict("type" => "plot_list", "plots" => plots)))
                end
                
                try
                    for msg in ws
                        handle_ws_message(ws, msg)
                    end
                catch e
                    if !(e isa EOFError || occursin("closed", string(e)))
                        @warn "R Plot Pro: WebSocket error" exception=e
                    end
                end
                
                delete!(clients, id)
            end, "127.0.0.1", port)
            end # with_logger
        catch e
            if !(e isa EOFError)
                @warn "R Plot Pro: Server error" exception=(e, catch_backtrace())
            end
        end
    end
    
    # One-shot method shadowing at startup
    ensure_method_shadowing()
    
    # Periodic Re-stacking Task (every 10 seconds) — NO method shadowing here!
    makie_shadowed = Ref(false)
    @async while !isnothing(server_task[])
        try
            ensure_display_at_top()
            # One-time Makie shadowing when it becomes available
            if !makie_shadowed[] && isdefined(Main, :Makie)
                ensure_method_shadowing()
                makie_shadowed[] = true
            end
        catch
        end
        sleep(10)
    end
end

function stop_plot_viewer()
    # Remove display
    filter!(d -> !(d isa RPlotProDisplay), Base.Multimedia.displays)
    
    # Currently HTTP.jl doesn't have a simple way to stop listen() from outside
    # except by killing the task or closing the sockets
    try
        last_stack_hash[] = 0
    catch
    end
    if !isnothing(server_task[])
        @async Base.throwto(server_task[], InterruptException())
    end
end

const last_stack_hash = Ref{UInt}(0)

function ensure_display_at_top()
    # Move our display to the top of the stack by removing it and re-pushing it.
    # Also attempt to demote VSCode's built-in displays.
    try
        # 0. Force Makie to use standard display stack if available
        if isdefined(Main, :Makie)
            try
                Base.invokelatest(getfield(Main, :Makie).inline!, true)
            catch
            end
        end

        stack = Base.Multimedia.displays
        types = [string(typeof(d)) for d in stack]
        new_hash = hash(types)
        
        last_stack_hash[] = new_hash

        # 1. Take ourselves out
        filter!(d -> !(d isa RPlotProDisplay), Base.Multimedia.displays)
        
        # 2. Identify VS Code displays and demote them
        # Usually VSCodeServer.InlineDisplay
        vscode_displays = filter(d -> contains(string(typeof(d)), "VSCodeServer") || contains(string(typeof(d)), "InlineDisplay"), Base.Multimedia.displays)
        if !isempty(vscode_displays)
            filter!(d -> !(d in vscode_displays), Base.Multimedia.displays)
            for vd in vscode_displays
                prepend!(Base.Multimedia.displays, [vd])
            end
        end
        
        # 3. Push ourselves to the extreme top
        pushdisplay(RPlotProDisplay())
    catch e
        @warn "R Plot Pro: Could not re-stack display" exception=e
    end
end

function ensure_method_shadowing()
    # 1. Master Interceptor (for general REPL display)
    try
        Base.eval(Main, quote
            function Base.display(x)
                if isdefined(Main, :RPlotPro) && Main.RPlotPro.is_plot_object(x)
                    Main.RPlotPro.capture_and_send(x)
                    return nothing
                end
                for d in reverse(Base.Multimedia.displays)
                    try
                        display(d, x)
                        return nothing
                    catch e
                        if !(e isa MethodError) || e.f != display || e.args != (d, x)
                            rethrow()
                        end
                    end
                end
                throw(MethodError(display, (x,)))
            end
        end)
    catch
    end

    # 2. VSCodeServer Hijack (The "Nuclear" option for VS Code)
    if isdefined(Main, :VSCodeServer)
        try
            # We reach into VSCodeServer and override their plot-handling entry points.
            Base.eval(Main.VSCodeServer, quote
                # Override their specialized display logic
                function display(x)
                    if Main.RPlotPro.is_plot_object(x)
                        Main.RPlotPro.capture_and_send(x)
                        return nothing
                    end
                    # Standard VSCodeServer.display behavior is complex; 
                    # but if it's not a plot, we let it fall through or 
                    # use the multimedia stack.
                    Base.Multimedia.display(x)
                end

                # Override their inline display hook
                function inline_display(x)
                    if Main.RPlotPro.is_plot_object(x)
                        Main.RPlotPro.capture_and_send(x)
                        return true # Handled!
                    end
                    return false # Not handled
                end
            end)
        catch
        end
    end
end

end # module
