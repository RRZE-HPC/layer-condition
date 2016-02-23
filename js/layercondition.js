// TODO add links to results table stats-rows with information on how to get these values
// TODO report more about orign of data (e.g., which two accesses lead to the reported reuse distance)
// TODO check window scaling behaviour of form fields and result table
// TODO use kilo and mega bytes when reporting bytes
// TODO report which access were hits and misses in report, maybe with coloring

values = obj => Object.keys(obj).map(key => obj[key]);

function nextChar(start, dist) {
    return String.fromCharCode(start.charCodeAt(0) + dist);
}

var gather_inputs = function() {
    // gather information from form
    var bytes_per_element = {"double": 8, "float": 4};
    var dims = parseInt($('#dimensions').val());
    
    var array_sizes = [];
    for(var i=0; i<dims; i++) {
        array_sizes.push(parseInt($('#ar_size'+i).val()));
    }
    
    var accesses = {};
    for(var i=0; $('#access_'+i).length == 1; i++) {
        var array_name = $('#access_'+i)[0].value;
        if(array_name.length == 0) {
            break;
        }
        var offsets = [];
        for(var j=0; $('#offset_'+i+nextChar('i', j)).length == 1; j++) {
            var val = parseInt($('#offset_'+i+nextChar('i', j))[0].value);
            if(isNaN(val)) {
                break;
            }
            offsets.push(val)
        }
        if(offsets.length == dims) {
            if(array_name in accesses) {
                accesses[array_name].push(offsets);
            } else {
                accesses[array_name] = [offsets];
            }
        }
    }
    
    return {
        dimensions: dims,
        arrays: {type: $('#type').val(),
                 bytes_per_element: bytes_per_element[$('#type').val()],
                 dimension: array_sizes},
        accesses: accesses,
        /* {a: [
            [0,0,0],
            [0,0,1], [0,0,-1],
            [0,1,0], [0,-1,0],
            [1,0,0], [-1,0,0]],
            b: [[0,0,0]]}, /*/
        cache_sizes: {
            L1: parseInt($('#l1_size').val())*1024,
            L2: parseInt($('#l2_size').val())*1024,
            L3: Math.floor(parseInt($('#l3_size').val())*1024/parseInt($('#cores').val()))},
        safety_margin: parseInt($("#safety-margin").val())};
}

var analyze_input = function(input) {
    var lc_analysis = {};
    var abs_offsets = {};
    var dim_sizes = {};
    var sliced_abs_offsets = {};
    
    // Calculate dimensional size (how many elements are part of one dimension)
    for(var dimension=0; dimension<input['dimensions']; dimension++) {
        dim_sizes[dimension] = input['arrays']['dimension'].slice(-1-dimension).reduce(
            (prev, curr) => prev*curr, 1);
    }
    
    // Calculate absolute offsets for each array
    for(var array_name in input['accesses']) {
        // compile offsets:
        abs_offsets[array_name] = [];
        for(var i in input['accesses'][array_name]) {
            // Calculate n-dimensional offset from center
            var offset = input['accesses'][array_name][i].slice(-1)[0]; // gets last element
            for(var d=1; d<input['dimensions']; d++) {
                offset += input['accesses'][array_name][i][input['dimensions']-1-d] 
                          * dim_sizes[d-1];
            }
            abs_offsets[array_name].push(offset);
        }
        
        // Sort numericaly for further processing
        abs_offsets[array_name].sort((a,b)=>a-b);
    }
    
    // Split offsets into dimensional slices
    for(var dimension=0; dimension<input['dimensions']; dimension++) {
        sliced_abs_offsets[dimension] = {};
        
        for(var array_name in input['accesses']) {
            sliced_abs_offsets[dimension][array_name] = abs_offsets[array_name].reduce(
                function(map, offset) {
                    var key = Math.round(offset/dim_sizes[dimension]);
        
                    if(!(key in map)) {
                        map[key] = [];
                    }
                    map[key].push(offset);
                    return map;
                }, {});
        }
    }
    
    // Perform a layer-condition analysis seperatly for each dimension to capture 1D, 2D and nD LCs
    for(var dimension=0; dimension<input['dimensions']; dimension++) {
        var analysis = {};
        var reuse_dists = {};
        var max_reuse = 0;
        var hit_offsets = {};
        var miss_offsets = {};
        
        // Get dimensional size (how many elements are part of one dimension)
        analysis['dimensional_size'] = dim_sizes[dimension];
        
        for(var array_name in input['accesses']) {
            reuse_dists[array_name] = [];
            hit_offsets[array_name] = [];
            miss_offsets[array_name] = [];
            
            // Turn absolute offsets into reuse distances for each slice (requires sorted offsets)
            for(var slice in sliced_abs_offsets[dimension][array_name]) {
                var before = sliced_abs_offsets[dimension][array_name][slice][0];
                miss_offsets[array_name].push(before); // this offset will be a miss under this LC
                
                for(var i=1; i<sliced_abs_offsets[dimension][array_name][slice].length; i++) {
                    next = sliced_abs_offsets[dimension][array_name][slice][i];
                    reuse_dists[array_name].push(next-before);
                    before = next;
                    
                    hit_offsets[array_name].push(next); // this offset will be a hit under this LC
                }
            }
            
            // max_reuse must be the largest reuse distance witin a slice per dimension
            max_reuse = Math.max(max_reuse, ...reuse_dists[array_name]);
        }
        
        var cache_requirement = 0;
        for(var array_name in reuse_dists) {
            // sum up all gaps
            for(o in reuse_dists[array_name]) {
                cache_requirement += reuse_dists[array_name][o];
            }
            // plus the max_reuse for each cached tail (that is for each slice)
            cache_requirement += max_reuse *
                 Object.keys(sliced_abs_offsets[dimension][array_name]).length;
        }
        // Multiply by bytes per element
        cache_requirement *= input['arrays']['bytes_per_element'];
        
        // TODO report number of reused and reloaded/missed bytes/elements
        analysis = $.extend(analysis, {
            max_reuse_distance_elements: max_reuse,
            max_reuse_distance_bytes: max_reuse * input['arrays']['bytes_per_element'],
            total_cache_requirement: cache_requirement,
            reuse_dists: reuse_dists,
            hit_offsets: hit_offsets,
            miss_offsets: miss_offsets});
        
        // Number of reuse distances effected by blocking
        analysis['blockable_offsets'] = 0;
        if(dimension >= 1) {
            analysis['blockable_offsets'] =
                // all new hits in this dimension can be blocked
                values(hit_offsets).reduce((prev,curr)=>prev+curr.length, 0) -
                values(lc_analysis[dimension+'D']['hit_offsets']).reduce(
                    (prev,curr)=>prev+curr.length, 0) +
                // plus all cached tails
                values(miss_offsets).reduce((prev,curr)=>prev+curr.length, 0);
        }
        
        analysis['inverse_occupation'] = {};
        // Inverse cache occupation (cache_size / total_cache_requirement)
        for(var cache_level in input['cache_sizes']) {
            analysis['inverse_occupation'][cache_level] = 
                input['cache_sizes'][cache_level] / cache_requirement;
        }
        
        // Blocking suggestions:
        // (cache_requirement - cache_size / safety_margin) / bytes_per_element / blockable_offsets
        var inner_array_size = input['arrays']['dimension'].slice(-1)[0];
        analysis['optimal_blocking'] = {};
        for(var cache_level in input['cache_sizes']) {
            analysis['optimal_blocking'][cache_level] = inner_array_size - 
                    (cache_requirement - input['cache_sizes'][cache_level]/input['safety_margin']) /
                    (analysis['blockable_offsets'] * input['arrays']['bytes_per_element']) /
                    (dim_sizes[dimension-1]/inner_array_size);
            
            if(analysis['optimal_blocking'][cache_level] > 1.0 &&
               max_reuse > (dim_sizes[dimension-1]/inner_array_size)) {
                // Floor blocking, because half elements do not make sense
                analysis['optimal_blocking'][cache_level] = Math.floor(
                    analysis['optimal_blocking'][cache_level])
            } else {
                // Every blocking with 1 or less means blocking won't help
                analysis['optimal_blocking'][cache_level] = null;
            }
        }
        
        lc_analysis[(dimension+1)+'D'] = analysis;
    }
    
    return lc_analysis;
}

var display_results = function(input, results) {
    // TODO update table
    $("#results-table").bootstrapTable('destroy');
    // Add statistical information to table
    var data = [
        $.extend({info: "longest reuse distance"},
                 ...Object.keys(results).map(function(k) {
            var map = {};
            map[k] = 
                results[k]['max_reuse_distance_elements'].toLocaleString('en-US')+" elements<br/>"+
                results[k]['max_reuse_distance_bytes'].toLocaleString('en-US')+" bytes";
            return map;
        })),
        $.extend({info: "min. required cache size"},
                 ...Object.keys(results).map(function(k) {
            var map = {};
            map[k] = results[k]['total_cache_requirement'].toLocaleString('en-US')+" bytes";
            return map;
        })),
    ];
    var stat_rows = data.length; // we need this to figure out where layer-conditions start at
    
    // Add LC analysis and predicted blocking to table
    for(var cache_level in input['cache_sizes']) {
        data.push(
            $.extend({info: "layer-condition in "+cache_level},
                      ...Object.keys(results).map(function(k) {
                var map = {};
                var fulfilled = results[k]['inverse_occupation'][cache_level];
                if(isFinite(fulfilled)) {
                    map[k] = Math.round(fulfilled*100) + "%";
                } else {
                    map[k] = "n/a";
                }
                return map;
            }))
        );
        data.push(
            $.extend({info: "optimal blocking for "+cache_level},
                      ...Object.keys(results).map(function(k) {
                var map = {};
                var blocking = results[k]['optimal_blocking'][cache_level];
                if(isFinite(blocking)) {
                    map[k] = blocking;
                } else {
                    map[k] = "n/a";
                }
                return map;
            }))
        );
    }
    
    // Make columns look nice
    var firstColumnCellStyle = {
        css: {"font-weight": "bold"}
    }
    var layerConditionCellStyle = function(value, row, index) {
        if(index >= stat_rows && (
                value == "n/a" || value == null || value.toString().endsWith("%"))) {
            if(parseInt(value) >= 100*input['safety_margin']) {
                return {css: {'background-color': '#77DD77'}};  // green
            }
            else if(parseInt(value) >= 100) {
                return {css: {'background-color': '	#FDFD96'}};  // yellow
            } else if(isFinite(parseInt(value))) {
                return {css: {'background-color': '#FF6961'}};  // red
            } else if(value == "n/a") {
                return {css: {'background-color': '#AEC6CF'}};  // blue
            }
        }
        return {};
    }
    var columns = [{
        field: 'info', 
        align: 'right', 
        width: '200px',
        cellStyle: (value, row, index) => firstColumnCellStyle
    }].concat(Object.keys(results).map(function(k) {
        return {
            field: k,
            title: k+" layer-condition",
            align: 'right',
            cellStyle: layerConditionCellStyle};
    }))
    
    $("#results-table").bootstrapTable({
        columns: columns,
        data: data,
    })
    
    $("#results").show()
}

$("#calc_btn").click(function() {
    var input = gather_inputs();
    console.log(input);
    // TODO check that data makes sens
    var results = analyze_input(input);
    console.log(results);
    display_results(input, results);
});

updated_dimension = function() {
    var dims = parseInt($("#dimensions").val())
    // TODO add/sub inputs to/from array sizes
    var template = $('#array_size_template');
    var dest = $('#array_size');
    while(dest.children().length != dims) {
        if(dest.children().length < dims) {
            var n = template.clone()
            n.show()
            n.find("input").attr("id", "ar_size"+dest.children().length);
            n.appendTo(dest);
        } else {
            dest.children().slice(-1).remove();
        }
    }
    // add/sub inputs to/from accesses
    var template = $('#array_access_offset_template');
    var dests = $('.array_access');
    for(var i=0; i<dests.length; i++) {
        dest = dests[i];
        while(dest.children.length != dims) {
            if(dest.children.length < dims) {
                var n = template.clone()
                n.show()
                n.removeAttr("id");
                //n[0].firstChild.nodeValue = '['+nextChar('i', dest.children.length);
                n.find("input").attr("id", "offset_"+i+nextChar('i', dest.children.length));
                n.appendTo(dest);
            } else {
                dest.children[dest.children.length-1].remove();
            }
        }
    }
};

$("#dimensions").change(updated_dimension);

var add_access_row = function() {
    var template = $('#array_access_template');
    var dest = $('#access_rows');
    
    var n = template.clone()
    n.show();
    n.removeAttr("id");
    n.find("input").attr("id", "access_"+dest.children().length);
    n.find("span").attr("class", "array_access") // so update_dimension does not update template
    n.appendTo(dest);
    
    updated_dimension();
};

$('#add_access').click(add_access_row);

$("#dimensions")[0].value = "3";
updated_dimension();
add_access_row();
