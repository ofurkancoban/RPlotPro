module RPlotPro

using Base64
using Random
using Dates

export start_plot_viewer, stop_plot_viewer, RPlotProDisplay

# Helper functions to retrieve modules in the latest world age.
# Crucial for Julia 1.12+ where modules themselves may be too "new" for static access.
get_json() = Base.invokelatest(getfield, Main, :JSON)
get_http() = Base.invokelatest(getfield, Main, :HTTP)

# Robust module resolution for plotting libraries to prevent UndefVarError in async context
function get_plots_module()
    try
        if isdefined(Main, :Plots)
            return Base.getfield(Main, :Plots)
        end
    catch
    end
    return nothing
end

function get_makie_module()
    try
        if isdefined(Main, :Makie)
            return Base.getfield(Main, :Makie)
        end
    catch
    end
    return nothing
end

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

function capture_and_send(plot_obj, update_id=nothing, width=nothing, height=nothing)
    try
        last_plot[] = plot_obj
        
        # Use provided dimensions or fallback to global Ref
        w = isnothing(width) ? client_dims[].width : round(Int, Float64(width))
        h = isnothing(height) ? client_dims[].height : round(Int, Float64(height))
        
        # Ensure we update client_dims if explicit ones were provided
        if !isnothing(width) && !isnothing(height)
            client_dims[] = (width=w, height=h)
        end
        
        obj_type = string(typeof(plot_obj))
        
        # Resolve modules aggressively 
        # DNA-Based Lookup: Extract module directly from the object's type to bypass scope blindness
        PlotsMod = nothing
        MakieMod = nothing
        
        try
            # We look at the "Origin" of the object
            origin_mod = parentmodule(typeof(plot_obj))
            origin_name = string(nameof(origin_mod))
            
            if origin_name == "Plots"
                PlotsMod = origin_mod
            elseif origin_name == "Makie"
                MakieMod = origin_mod
            end
        catch
        end
        
        # Fallback to Global Lookup if DNA failed or module was different
        if isnothing(PlotsMod)
            try
                if isdefined(Main, :Plots)
                    PlotsMod = Base.getfield(Main, :Plots)
                end
            catch
            end
        end
        
        if isnothing(MakieMod)
            try
                if isdefined(Main, :Makie)
                    MakieMod = Base.getfield(Main, :Makie)
                end
            catch
            end
        end
        
        # Relaxed type check to catch wrapped plot objects
        is_plots_obj = occursin("Plots.Plot", obj_type) || occursin("Plots.Subplot", obj_type)
        is_makie_obj = occursin("Makie.Figure", obj_type) || occursin("Makie.Scene", obj_type) || occursin("Makie.FigureAxisPlot", obj_type)
        
        if !isnothing(PlotsMod) && is_plots_obj
            try
                
                # [NUCLEAR] GKS Master Reset - force the graphics engine to die and reborn with new size
                try
                    backend_name = string(Base.invokelatest(PlotsMod.backend))
                    if occursin("GR", backend_name) && hasproperty(PlotsMod, :GR)
                        # Close the old stubborn workstation
                        try
                            Base.invokelatest(PlotsMod.GR.emergencyclosegks)
                        catch
                        end
                        
                        # Dominant environment variables
                        ENV["GR_WIDTH"] = string(w)
                        ENV["GR_HEIGHT"] = string(h)
                    end
                catch
                end
                
                # [NUCLEAR] Update global defaults
                try
                    Base.invokelatest(PlotsMod.default, size=(w, h), aspect_ratio=:auto)
                    
                    # Also try updating the specific GR viewport if possible
                    if hasproperty(PlotsMod, :GR)
                        try
                            Base.invokelatest(PlotsMod.GR.set_viewport_size, w, h)
                        catch
                        end
                    end
                catch
                end
                
                # Proactive attribute forcing
                try
                    # Handles both Plot and Subplot objects
                    if hasproperty(plot_obj, :attr)
                        plot_obj.attr[:size] = (w, h)
                        plot_obj.attr[:aspect_ratio] = :auto
                    end
                catch
                end
                
                # Re-render with explicit size and auto aspect ratio
                plot_obj = Base.invokelatest(PlotsMod.plot, plot_obj, size=(w, h), aspect_ratio=:auto)
                
                # [NEW] Force layout recalculation
                try
                    Base.invokelatest(PlotsMod.prepare_output, plot_obj)
                catch
                end
                
                last_plot[] = plot_obj
            catch e
                @warn "R Plot Pro: Plots.jl re-render failed" exception=e
            end
        elseif !isnothing(MakieMod) && is_makie_obj
            try
                # Also set environment hints for Makie backends that might use them
                ENV["GLMakie_WINDOW_SIZE"] = "$(w),$(h)"
                
                Base.invokelatest(MakieMod.resize!, plot_obj, w, h)
                if hasproperty(plot_obj, :scene)
                    Base.invokelatest(MakieMod.resize!, plot_obj.scene, w, h)
                end
            catch e
                @warn "R Plot Pro: Makie resize failed" exception=e
            end
        end
        
        # Capture with size hints via IOContext - crucial for Makie/Plots.jl
        io = IOBuffer()
        # Provide both :size and :resolution for maximum backend compatibility
        ctx = IOContext(io, :size => (w, h), :resolution => (w, h))
        
        try
            Base.invokelatest(show, ctx, MIME("image/svg+xml"), plot_obj)
        catch e
            # Fallback to PNG
            Base.invokelatest(show, ctx, MIME("image/png"), plot_obj)
        end
        
        raw_data = take!(io)
        
        if length(raw_data) < 100
             @error "R Plot Pro: Captured data is too small (size=$(length(raw_data)) bytes). Skipping broadcast."
             return
        end
        
        # Removed duplicate and dangerous String(raw_data) SVG reflow string processing.
        # Format detection and single SVG patching pass will be performed below instead.
        
        # Use existing ID if it's a re-render/resize, otherwise generate new one
        id = isnothing(update_id) ? "j-$(floor(Int, datetime2unix(now()) * 1000))" : string(update_id)
        # Use simple sniff for format
        format = "svg" # Default to svg in this branch
        if length(raw_data) > 8 && raw_data[1:8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
            format = "png"
        end
        
        metadata = Dict(
            "id" => id,
            "timestamp" => Dates.format(now(), "HH:MM:SS"),
            "format" => format,
            "width" => w,
            "height" => h,
            "type" => isnothing(update_id) ? "new_plot" : "update_plot"
        )
        
        if isnothing(update_id)
            # New plot: Manage history (keep last 100)
            push!(plots, metadata)
            if length(plots) > 100
                old = popfirst!(plots)
                delete!(recordings, old["id"])
                delete!(raw_plots, old["id"])
            end
        else
            # Re-render: update metadata in place to prevent gallery duplication
            found = false
            for (i, p) in enumerate(plots)
                if string(p["id"]) == id
                    plots[i] = metadata
                    found = true
                    break
                end
            end
            if !found
                push!(plots, metadata) # Müzmin fallback
            end
        end
        
        recordings[id] = plot_obj
        
        # 2. SVG Patching - Force the SVG header to respect our w/h
        if format == "svg"
            svg_str = String(copy(raw_data))
            
            # Trust library coordinate system (viewBox) to prevent cropping
            if !occursin("viewBox", svg_str)
                svg_str = replace(svg_str, r"(<svg)" => SubstitutionString("\\1 viewBox=\"0 0 $(w) $(h)\""))
            end
            
            # Remove any existing preserveAspectRatio to revert to default behavior (meet)
            svg_str = replace(svg_str, r"preserveAspectRatio=\"[^\"]*\"" => "")
            
            # 2b. Fluid Filling
            # Use 100% dimensions but trust the library's viewBox aspect ratio
            override_attrs = " width=\"100%\" height=\"100%\" preserveAspectRatio=\"xMidYMid meet\""
            
            # Remove existing W/H/preserveAspectRatio from the start tag
            svg_str = replace(svg_str, r"(<svg[^>]*?)\s+width=[\"'][^\"']*[\"']" => s"\1")
            svg_str = replace(svg_str, r"(<svg[^>]*?)\s+height=[\"'][^\"']*[\"']" => s"\1")
            svg_str = replace(svg_str, r"(<svg[^>]*?)\s+preserveAspectRatio=[\"'][^\"']*[\"']" => s"\1")
            
            # Inject new fluid attributes
            svg_str = replace(svg_str, r"(<svg)" => SubstitutionString("\\1 $(override_attrs)"))
            
            raw_data = Vector{UInt8}(codeunits(svg_str))
        end
        
        # Broadcast the new plot
        
        raw_plots[id] = raw_data
        
        msg_type = isnothing(update_id) ? "new_plot" : "update_plot"
        broadcast_plot(raw_data, metadata, msg_type)
    catch e
        @warn "R Plot Pro: Error capturing plot" exception=(e, catch_backtrace())
    end
end

function broadcast_plot(bin_payload, metadata, msg_type="new_plot")
    for (id, ws) in clients
        send_binary(ws, msg_type, bin_payload, metadata)
    end
end

function send_binary(ws, type, bin_payload, metadata=Dict())
    metadata["type"] = type
    meta_json = Base.invokelatest(get_json().json, metadata)
    meta_bytes = Vector{UInt8}(codeunits(meta_json))
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
    elseif data["type"] == "delete_plot"
        pid = string(get(data, "plot_id", ""))
        if !isempty(pid)
            filter!(p -> string(p["id"]) != pid, plots)
            delete!(recordings, pid)
            delete!(raw_plots, pid)
            # Broadcast updated list to all clients
            msg = Base.invokelatest(get_json().json, Dict("type" => "plot_list", "plots" => plots))
            for (cid, ws_client) in clients
                try
                    Base.invokelatest(get_http().WebSockets.send, ws_client, msg)
                catch
                end
            end
        end
    elseif data["type"] == "resize"
        new_w = round(Int, Float64(data["width"]))
        new_h = round(Int, Float64(data["height"]))
        
        # Prevent infinite loops: only re-render if dimensions changed meaningfully
        old_w = client_dims[].width
        old_h = client_dims[].height
        
        if abs(new_w - old_w) >= 1 || abs(new_h - old_h) >= 1
            # Language Isolation: Only handle Julia plots with explicit 'j-' prefix
            pid = get(data, "plot_id", nothing)
            if isnothing(pid) || !startswith(string(pid), "j-")
                return
            end
            
            client_dims[] = (width=new_w, height=new_h)
            
            # Target Selection: 
            # 1. Try exact match in memory (Fastest)
            # 2. Fallback to last_plot if ID not found BUT prefix matches 'j-'
            # This is safe because the Frontend already routed this to OUR port specifically.
            target = get(recordings, string(pid), nothing)
            if isnothing(target)
                target = last_plot[]
            end
            
            if !isnothing(target)
                # Keep the requested ID for the update message to ensure frontend consistency
                capture_and_send(target, pid, new_w, new_h)
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

    # Do not start a second server if one is already running (e.g. the startup.jl
    # hook started it before the sentinel injection fires). Mirrors the R guard.
    if !isnothing(server_task[]) && !istaskdone(server_task[])
        return
    end

    if isnothing(port)
        port = rand(10000:30000)
    end
    
    # Shared config logic
    env_config_path = get(ENV, "VSCODE_R_PLOT_CONFIG", "")
    config_file = if isdir(env_config_path)
        joinpath(env_config_path, "port_$port.json")
    elseif !isempty(env_config_path)
        env_config_path
    else
        joinpath(pwd(), ".r_plot_config.json")
    end
    
    # Suppress external GR/GKS windows
    ENV["GKSwstype"] = "100"
    
    # Write port to config
    open(config_file, "w") do f
        Base.invokelatest(get_json().print, f, Dict("port" => port, "language" => "julia"))
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

    # Add terminal exit cleanup
    atexit() do
        try
            if isfile(config_file)
                 rm(config_file, force=true)
            end
        catch
        end
    end
    
    # One-shot method shadowing at startup
    ensure_method_shadowing()
    
    # Periodic Re-stacking Task (every 5 seconds)
    vscode_shadowed = Ref(false)
    makie_shadowed = Ref(false)
    @async while !isnothing(server_task[])
        try
            ensure_display_at_top()
            
            # One-time Makie shadowing when it becomes available
            if !makie_shadowed[] && isdefined(Main, :Makie)
                ensure_method_shadowing()
                makie_shadowed[] = true
            end
            
            # Check for VSCodeServer presence during runtime
            if !vscode_shadowed[] && isdefined(Main, :VSCodeServer)
                ensure_method_shadowing()
                vscode_shadowed[] = true
            end
        catch e
        end
        sleep(5.0)
    end
end

function stop_plot_viewer()
    # Remove display
    filter!(d -> !(d isa RPlotProDisplay), Base.Multimedia.displays)
    
    if !isnothing(server_task[])
        @async Base.throwto(server_task[], InterruptException())
    end
end

const last_stack_hash = Ref{UInt}(0)

function ensure_display_at_top()
    # Move our display to the top of the stack by removing it and re-pushing it.
    # Also attempt to demote VS Code's built-in displays.
    try
        # 0. Force Makie to use standard display stack if available
        if isdefined(Main, :Makie)
            try
                Base.invokelatest(getfield(Main, :Makie).inline!, true)
            catch
            end
        end

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
    end
end

function ensure_method_shadowing()
    # 1. Master Interceptor (for general REPL display)
    try
        Base.eval(Main, quote
            function Base.display(x)
                # Use invokelatest to handle potential world age issues with newly loaded plot objects
                if isdefined(Main, :RPlotPro) && Base.invokelatest(Main.RPlotPro.is_plot_object, x)
                    Base.invokelatest(Main.RPlotPro.capture_and_send, x)
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
                    if isdefined(Main, :RPlotPro) && Base.invokelatest(Main.RPlotPro.is_plot_object, x)
                        Base.invokelatest(Main.RPlotPro.capture_and_send, x)
                        return nothing
                    end
                    Base.Multimedia.display(x)
                end

                # Override their inline display hook
                function inline_display(x)
                    if isdefined(Main, :RPlotPro) && Base.invokelatest(Main.RPlotPro.is_plot_object, x)
                        Base.invokelatest(Main.RPlotPro.capture_and_send, x)
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
