var tap = require('tap')
  , test = tap.test
  , request = require('request')

var api = require('../api')

var DB = 'http://localhost:5984/test_static_plus'


test('Builder API', function(t) {
  var builder;

  t.doesNotThrow(function() { builder = new api.Builder }, 'Create a new builder')
  t.ok(builder, 'Got a builder object')

  function start() { builder.start() }

  var did = {}
  builder.on('template', function(template) { did.template = template })
  builder.on('output'  , function(output)   { did.output   = output   })
  builder.on('source'  , function(source)   { did.source   = source    })
  builder.on('start'   , function()         { did.start    = true     })

  builder.template = null
  t.throws(start, 'Throw for missing template')

  builder.template = 1;
  t.throws(start, 'Throw for bad template type')
  builder.template = function(doc) { return 'Doc!' }

  t.throws(start, 'Throw for missing output')
  builder.output = __dirname + '/output'

  t.throws(start, 'Throw for missing source db')

  builder.source = 'not_a_url'
  t.throws(start, 'Throw for bad Couch URL')

  var http_begin = new Date;
  request({method:'DELETE', json:true, uri:DB}, function(er, res) {
    if(er) throw er;
    if(res.error && res.error != 'not_found')
      throw new Error('Failed to delete test DB: ' + JSON.stringify(res.body))

    request({method:'PUT', json:true, uri:DB}, function(er, res) {
      if(er) throw er;
      if(res.error && res.error != 'file_exists')
        throw new Error('Failed to create test DB: ' + JSON.stringify(res.body))

      var http_end = new Date
        , http_duration = http_end - http_begin

      builder.source = DB
      t.doesNotThrow(start, 'No throw for all good starting data')

      setTimeout(check_events, http_duration * 1.5)
    })
  })

  function check_events() {
    t.ok(did.output, 'The output event finally fired')
    t.ok(did.template, 'The template event finally fired')
    t.ok(did.source, 'The source event finally fired')
    t.ok(did.start, 'The builder started')

    t.end()
  }
})
