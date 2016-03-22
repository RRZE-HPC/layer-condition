// TODO report more about orign of data (e.g., which two accesses lead to the reported reuse distance)
// TODO check window scaling behaviour of form fields and result table
// TODO use kilo and mega bytes when reporting bytes
// TODO report which access were hits and misses in report, maybe with coloring
// TODO better input of offsets
// TODO allow selection of typical cache configurations

function values(obj) {
    return Object.keys(obj).map(function(key) {return obj[key]});
}

function nextChar(start, dist) {
    return String.fromCharCode(start.charCodeAt(0) + dist);
}

var gather_inputs = function() {
    // gather information from form
    var bytes_per_element = {"double": 8, "float": 4};
    var dims = parseInt($('#dimensions').val());

    var array_sizes = [];
    for(var i=0; i<dims; i++) {
        array_sizes.unshift(parseInt($('#ar_size'+i).val()));
    }

    var accesses = {};
    for(var i=0; $('#access_'+i).length == 1; i++) {
        var array_name = $('#access_'+i)[0].value;
        if(array_name.length == 0) {
            continue;
        }
        var offsets = [];
        for(var j=0; $('#offset_'+i+nextChar('i', j)).length == 1; j++) {
            var val = parseInt($('#offset_'+i+nextChar('i', j))[0].value);
            if(isNaN(val)) {
                break;
            }
            offsets.unshift(val)
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
            L1: {
                size: parseInt($('#l1_size').val())*1024,
                cores: parseInt($('#l1_cores').val()),
                available: Math.floor(
                    parseInt($('#l1_size').val())*1024/parseInt($('#l1_cores').val()))
            },
            L2: {
                size: parseInt($('#l2_size').val())*1024,
                cores: parseInt($('#l2_cores').val()),
                available: Math.floor(
                    parseInt($('#l2_size').val())*1024/parseInt($('#l2_cores').val()))
            },
            L3: {
                size: parseInt($('#l3_size').val())*1024,
                cores: parseInt($('#l3_cores').val()),
                available: Math.floor(
                    parseInt($('#l3_size').val())*1024/parseInt($('#l3_cores').val()))
            }},
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
            function(prev, curr) {return prev*curr}, 1);
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
        abs_offsets[array_name].sort(function(a,b) {return a-b});
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
            max_reuse = Math.max.apply(0, [max_reuse].concat(reuse_dists[array_name]));
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

        // TODO report number of reused and reloaded/missed bytes/elements
        analysis = $.extend(analysis, {
            max_reuse_distance_elements: max_reuse,
            max_reuse_distance_bytes: max_reuse * input['arrays']['bytes_per_element'],
            total_cache_requirement_elements: cache_requirement,
            total_cache_requirement_bytes: cache_requirement * input['arrays']['bytes_per_element'],
            reuse_dists: reuse_dists,
            hit_offsets: hit_offsets,
            miss_offsets: miss_offsets});

        // Number of reuse distances effected by blocking
        analysis['blockable_offsets'] = 0;
        if(dimension >= 1) {
            analysis['blockable_offsets'] =
                // all new hits in this dimension can be blocked
                values(hit_offsets).reduce(function(prev,curr){return prev+curr.length}, 0) -
                values(lc_analysis[dimension+'D']['hit_offsets']).reduce(
                    function(prev,curr){return prev+curr.length}, 0) +
                // plus all cached tails
                values(miss_offsets).reduce(function(prev,curr){return prev+curr.length}, 0);
        }
        
        analysis['inverse_occupation'] = {};
        // Inverse cache occupation (cache_size / total_cache_requirement_bytes)
        for(var cache_level in input['cache_sizes']) {
            analysis['inverse_occupation'][cache_level] =
                input['cache_sizes'][cache_level]['available'] /
                (cache_requirement * input['arrays']['bytes_per_element']);
        }

        // Blocking suggestions:
        // N*M*K*... (dep. on dim.) <= (dim_sizes[dimension-1] - (cach_requirement_bytes - cache_size / safety_margin) / bytes_per_element / blockable_offsets)^(1/dimension)
        var inner_array_size = input['arrays']['dimension'].slice(-1)[0];
        analysis['suggested_blocking'] = {};
        for(var cache_level in input['cache_sizes']) {
            var lhs = '';
            for(var i=0; i<dimension; ++i) {
                lhs += nextChar('N', -i);
            }
            
            var rhs = (dim_sizes[dimension-1] -
                       (cache_requirement * input['arrays']['bytes_per_element'] -
                           input['cache_sizes'][cache_level]['available']/input['safety_margin']) /
                       (analysis['blockable_offsets'] * input['arrays']['bytes_per_element'])
                      )^(1/dimension)

            analysis['suggested_blocking'][cache_level] = {'lhs': lhs, 'rhs': rhs};
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
        $.extend.apply({}, [{info: "longest reuse distance"}].concat(
                 Object.keys(results).map(function(k) {
            var map = {};
            map[k] =
                results[k]['max_reuse_distance_elements'].toLocaleString('en-US')+" elements<br/>"
                + results[k]['max_reuse_distance_bytes'].toLocaleString('en-US')+" bytes";
            return map;
        }))),
        $.extend.apply({}, [{info: "min. required cache size"}].concat(
                 Object.keys(results).map(function(k) {
            var map = {};
            map[k] = results[k]['total_cache_requirement_elements'].toLocaleString('en-US')
                     + " elements<br/>"
                     + results[k]['total_cache_requirement_bytes'].toLocaleString('en-US')+" bytes";
            return map;
        }))),
        $.extend.apply({}, [{info: "cache misses"}].concat(
                 Object.keys(results).map(function(k) {
            var map = {};
            misses = values(results[k]['miss_offsets']).reduce(
                function(prev,curr){return prev+curr.length}, 0);
            map[k] = misses.toLocaleString('en-US')+" elements<br/>"+
                     (misses*input['arrays']['bytes_per_element']).toLocaleString('en-US')+" bytes";
            return map;
        }))),
        $.extend.apply({}, [{info: "cache hits"}].concat(
                 Object.keys(results).map(function(k) {
            var map = {};
            hits = values(results[k]['hit_offsets']).reduce(
                function(prev,curr){return prev+curr.length}, 0);
            map[k] = hits.toLocaleString('en-US')+" elements<br/>"+
                     (hits*input['arrays']['bytes_per_element']).toLocaleString('en-US')+" bytes";
            return map;
        }))),
    ];
    var stat_rows = data.length; // we need this to figure out where layer-conditions start at

    // Add LC analysis and predicted blocking to table
    for(var cache_level in input['cache_sizes']) {
        data.push(
            $.extend.apply({}, [{info: "layer-condition in "+cache_level}].concat(
                    Object.keys(results).map(function(k) {
                var map = {};
                var fulfilled = results[k]['inverse_occupation'][cache_level];
                if(isFinite(fulfilled)) {
                    map[k] = Math.round(fulfilled*100) + "%*";
                } else {
                    map[k] = "n/a";
                }
                return map;
            })))
        );
        data.push(
            $.extend.apply({}, [{info: "suggested blocking** for "+cache_level}].concat(
                    Object.keys(results).map(function(k) {
                var map = {};
                var blocking = results[k]['suggested_blocking'][cache_level];
                if(blocking['rhs'] > 0) {
                    map[k] = '\\('+blocking['lhs']+' \\lesssim ' + 
                             blocking['rhs'].toString()+'\\) elements';
                } else {
                    map[k] = "n/a";
                }
                return map;
            })))
        );
    }

    // Make columns look nice
    var firstColumnCellStyle = {
        css: {"font-weight": "bold"}
    }
    var layerConditionCellStyle = function(value, row, index) {
        if(index >= stat_rows && (
                value == "n/a" || value == null || value.toString().endsWith("%*"))) {
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
        cellStyle: function(value, row, index) {return firstColumnCellStyle}
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
    
    // Rerun MathJax to render formulae in table
    MathJax.Hub.Queue(["Typeset",MathJax.Hub]);

    $("#results").show()
}

$("#calc_btn").click(function() {
    var input = gather_inputs();
    console.log(input);
    // TODO check that data makes sens
    var results = analyze_input(input);
    console.log(results);
    display_results(input, results);

    // Add link with current configuration
    $('#pre-filled-link').remove();
    var link = document.createElement("a");
    link.id = "pre-filled-link";
    link.appendChild(document.createTextNode("Link to pre-filled form."));
    link.href = "#calculator%23!"+encodeURIComponent(JSON.stringify(gather_inputs()));
    $("#results")[0].insertBefore(link, $("#results-table-div")[0]);
});

updated_dimension = function() {
    var dims = parseInt($("#dimensions").val())
    // TODO add/sub inputs to/from array sizes
    var template = $('#array_size_template');
    var dest = $('#array_define tr:first');
    var count = 0;
    while(dest.children().length-1 != dims) {
        if(dest.children().length-1 < dims) {
            // add and delete from front
            var n = template.clone()
            n.wrapInner('<td></td>')
            n = n.children()
            n.show()
            n.find("input").attr("id", "ar_size"+(dest.children().length-1));
            
            // Insert created element
            n.insertAfter($('#type_col'));
            
            // Update index row
            var n_ind = $('<td>'+nextChar('N', -(dest.children().length-2))+'</td>');
            n_ind.insertAfter($('#type_index_col'))
        } else {
            // remove unneeded columns
            dest.children()[1].remove();
            $('#array_indices').children()[1].remove();
        }
    }
    // add/sub inputs to/from accesses
    var template = $('#array_access_offset_template');
    var dests = $('.array_access');
    for(var i=0; i<dests.length; i++) {
        dest = dests[i];
        while(dest.children.length != dims) {
            // TODO add and delete from front
            if(dest.children.length < dims) {
                var n = template.clone()
                n.show()
                n.removeAttr("id");
                n.find("input").attr("id", "offset_"+i+nextChar('i', dest.children.length));
                n.prependTo(dest);
            } else {
                dest.children[0].remove();
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

// Update navbar when clicked
$(".nav a").on("click", function(){
   $(".nav").find(".active").removeClass("active");
   $(this).parent().addClass("active");
});

scatter_inputs = function(input) {
    // Fill form according to input
    $("#dimensions")[0].value = input['dimensions'];
    $("#dimensions").change();

    $('#type')[0].value = input['arrays']['type'];
    for(var i=0; i<input['dimensions']; i++) {
        $('#ar_size'+(input['dimensions']-1-i))[0].value = input['arrays']['dimension'][i];
    }

    // clear access rows
    $('#access_rows').children().remove();

    // row counter
    var i = 0;
    for(var var_name in input['accesses']) {
        for(var j=0; j<input['accesses'][var_name].length; j++) {
            // Check that another access form fields row is available
            if($('#access_rows').children().length < i+1) {
                add_access_row();
            }

            $('#access_'+i)[0].value = var_name;

            // add dimensions
            for(var k=0; k<input['dimensions']; k++) {
                $('#offset_'+i+nextChar('i', input['dimensions']-1-k))[0].value =
                     input['accesses'][var_name][j][k];
            }

            // increment row counter
            i++;
        }
    }

    // Update cache sizes and sharing
    $('#l1_size')[0].value = Math.round(input['cache_sizes']['L1']['size']/1024);
    $('#l2_size')[0].value = Math.round(input['cache_sizes']['L2']['size']/1024);
    $('#l3_size')[0].value = Math.round(input['cache_sizes']['L3']['size']/1024);
    $('#l1_cores')[0].value = Math.round(input['cache_sizes']['L1']['cores']);
    $('#l2_cores')[0].value = Math.round(input['cache_sizes']['L2']['cores']);
    $('#l3_cores')[0].value = Math.round(input['cache_sizes']['L3']['cores']);

    // Update safety margin
    $("#safety-margin")[0].value = input['safety_margin'];

    console.log("updated form");
}

// wait for calculator hash and parse appended form information
window.onhashchange = function(){
    var hash = location.hash.substr(1);

    // We only intercept hashes that start with calculator and contain a hashbang
    if(!(hash.startsWith('calculator') && hash.search('%23!') >= 0)) return;
    // example encoding:
    // #calculator#!%7B%22dimensions%22%3A2%2C%22arrays%22%3A%7B%22type%22%3A%22double%22%2C%22bytes_per_element%22%3A8%2C%22dimension%22%3A%5B1024%2C1024%5D%7D%2C%22accesses%22%3A%7B%22a%22%3A%5B%5B0%2C1%5D%2C%5B0%2C-1%5D%2C%5B-1%2C0%5D%2C%5B1%2C0%5D%5D%2C%22b%22%3A%5B%5B0%2C0%5D%5D%7D%2C%22cache_sizes%22%3A%7B%22L1%22%3A%7B%22size%22%3A32768%2C%22cores%22%3A1%2C%22available%22%3A32768%7D%2C%22L2%22%3A%7B%22size%22%3A262144%2C%22cores%22%3A1%2C%22available%22%3A262144%7D%2C%22L3%22%3A%7B%22size%22%3A20971520%2C%22cores%22%3A1%2C%22available%22%3A20971520%7D%7D%2C%22safety_margin%22%3A2%7D

    // extract relevant string
    data_str = hash.substr(hash.search('%23!')+4);
    data = JSON.parse(decodeURIComponent(data_str));

    // Fill form accordingly
    scatter_inputs(data);

    // Set location to calculator, so we end up at the right place
    location.hash = 'calculator';

    // Calculate results
    $("#calc_btn").click
};

// Since the event is only triggered when the hash changes, we need to trigger
// the event now, to handle the hash the page may have loaded with.
window.onhashchange();

$('#add_access').click(add_access_row);

// Default values
updated_dimension();
add_access_row();
