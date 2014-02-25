var util = require("util");
var EventEmitter = require("events").EventEmitter;
var path = require("path");
var opcua = require("./nodeopcua");
var read_certificate = require("../lib/crypto_utils").read_certificate;
var crypto = require("crypto");
var async = require("async");
var _ = require("underscore");
var assert= require('better-assert');

var ClientSecureChannelLayer =require("./client/client_secure_channel_layer").ClientSecureChannelLayer;
var s = require("./structures");
var nodeids = require("./opcua_node_ids").DataType;
var ec = require("./encode_decode");
var resolveNodeId = require("./nodeid").resolveNodeId;

var debugLog  = require("../lib/utils").make_debugLog(__filename);

var OPCUAClientBase = require("../lib/client/client_base").OPCUAClientBase;



function OPCUAClient(){
    OPCUAClientBase.apply(this,arguments);
}
util.inherits(OPCUAClient,OPCUAClientBase);




var OPCUASession = function(client) {
    assert(client instanceof OPCUAClient);
    this._client = client;
};


var browse_service = require("./browse_service");


/**
 * @example:
 *
 *     session.browse("RootFolder",function(err,results,diagnostics) {} );
 *
 * @param nodes
 * @param callback
 */
OPCUASession.prototype.browse = function(nodes,callback) {


    assert(typeof(callback) === "function");

    if (!_.isArray(nodes)) { nodes = [nodes]; }

    var nodesToBrowse = [];
    nodes.forEach(function(node) {
        nodesToBrowse.push({
            nodeId: resolveNodeId(node),
            includeSubtypes: true,
            browseDirection: browse_service.BrowseDirection.Both,
            resultMask: 63
        });
    });

    var request = new browse_service.BrowseRequest({ nodesToBrowse:nodesToBrowse });

    this.performMessageTransaction(request,function(err,response){
        if(err) {
            callback(err,null,response);
        } else {
            assert(response instanceof browse_service.BrowseResponse);
            // console.log(JSON.stringify(response.results,null," ").yellow.bold);
            callback(null,response.results,response.diagnosticInfos);
        }
    });

};


var read_service = require("./read_service");
/**
 * @example:
 *
 *     session.readVariableValue("ns=2;s=Furnace_1.Temperature",function(err,dataValues,diagnostics) {} );
 *
 * @param nodes
 * @param callback
 */
OPCUASession.prototype.readVariableValue = function(nodes,callback) {

    assert(typeof(callback) === "function");
    if (!_.isArray(nodes)) { nodes = [nodes]; }


    var nodesToRead = [];

    nodes.forEach(function(node) {
        nodesToRead.push( {
            nodeId: resolveNodeId(node),
            attributeId: read_service.AttributeIds.Value,
            indexRange: null,
            dataEncoding: { id:0 , name: null}
        });
    });

    var request = new read_service.ReadRequest({ nodesToRead: nodesToRead });

    assert( nodes.length === request.nodesToRead.length);

    this.performMessageTransaction(request, function(err,response) {

        if(err) {
            callback(err,response);
        } else {
            assert(response instanceof read_service.ReadResponse);
            assert( nodes.length === response.results.length);
            callback(null,response.results,response.diagnosticInfos);
        }
    });

};


/**
 * @example:
 *
 *     session.readAllAttributes("ns=2;s=Furnace_1.Temperature",function(err,dataValues,diagnostics) {} );
 *
 * @param nodes
 * @param callback
 */
OPCUASession.prototype.readAllAttributes = function(nodes,callback) {

    assert(typeof(callback) === "function");
    if (!_.isArray(nodes)) { nodes = [nodes]; }


    var nodesToRead = [];

    nodes.forEach(function(node) {
        Object.keys(read_service.AttributeIds).forEach(function(key){
            var attributeId =read_service.AttributeIds[key];
            nodesToRead.push( {
                nodeId: resolveNodeId(node),
                attributeId: attributeId,
                indexRange: null,
                dataEncoding: { id:0 , name: null}
            });
        })
    });

    var request = new read_service.ReadRequest({ nodesToRead: nodesToRead });


    this.performMessageTransaction(request, function(err,response) {

        if(err) {
            callback(err,response);
        } else {
            assert(response instanceof read_service.ReadResponse);
            callback(null,nodesToRead,response.results,response.diagnosticInfos);
        }
    });

};

OPCUASession.prototype.performMessageTransaction = function(request,callback) {

    assert(typeof(callback) === "function");
    request.requestHeader.authenticationToken = this.authenticationToken;
    this._client._secureChannel.performMessageTransaction(request,callback);
};


OPCUASession.prototype.close = function(callback) {
    this._client.closeSession(this,callback);
};



OPCUAClient.prototype._nextSessionName = function()
{
    if (!this.___sessionName_counter) {
        this.___sessionName_counter = 0;
    }
    this.___sessionName_counter += 1;
    return 'Session' + this.___sessionName_counter;
};


OPCUAClient.prototype._createSession = function(callback) {


    assert(typeof(callback) === "function");

    if (!this._secureChannel) {
        callback(new Error(" No secure channel"));
        return;
    }

    var endpoint = this.findEndpoint(this._secureChannel.endpoint_url);

    if (!endpoint) {
        callback(new Error( " End point must exist " + this._secureChannel.endpoint_url));
        return;
    }

    this.serverUri = endpoint.server.applicationUri;

    this.endpoint_url =this._secureChannel.endpoint_url;
    this.endpoint_url = "opc.tcp://localhost:51210/UA/SampleServer";

    var applicationDescription = new s.ApplicationDescription({
        applicationUri: "urn:localhost:application:",
        productUri: "http://localhost/application",
        applicationName: { text: "MyApplication"},
        applicationType: s.ApplicationType.CLIENT,
        gatewayServerUri: undefined,
        discoveryProfileUri: undefined,
        discoveryUrls: []
    });

    assert(this.serverUri," must have a valid server URI");
    assert(this.endpoint_url," must have a valid server endpoint_url");

    var request = new s.CreateSessionRequest({
              clientDescription: applicationDescription,
                      serverUri: this.serverUri,
                    endpointUrl: this.endpoint_url,
                    sessionName: this._nextSessionName(),
                    clientNonce: this._clientNonce,
              clientCertificate: null, //xx this._certificate,
        requestedSessionTimeout: 300000,
         maxResponseMessageSize: 800000
    });

    // console.log(JSON.stringify(request,null," "));

    var self  = this;
    self._secureChannel.performMessageTransaction(request,function(err,response){

        if (!err) {

            assert( response instanceof s.CreateSessionResponse);

            //
            // todo: verify SignedSoftwareCertificates and  response.serverSignature
            //
            var session = new OPCUASession(self);
            session.name                = request.sessionName;

            session.sessionId           = response.sessionId;
            session.authenticationToken = response.authenticationToken;
            session.timeout             = response.revisedSessionTimeout;
            session.serverNonce         = response.serverNonce;
            session.serverCertificate   = response.serverCertificate;
            session.serverSignature     = response.serverSignature;


            callback(null,session);

        } else {
            callback(err,null);
        }
    });

};


// see OPCUA Part 4 - $7.35

OPCUAClient.prototype._activateSession = function(session,callback) {
    assert(typeof(callback) === "function");

    if (!this._secureChannel) {
        callback(new Error(" No secure channel"));
    }

    var request = new s.ActivateSessionRequest({
        clientSignature: { algorithm: null, signature: null },

        clientSoftwareCertificates: [

        ],

        localeIds: [
        ],
        userIdentityToken: new s.AnonymousIdentityToken({
            policyId: "0"
        }), // extension object
        userTokenSignature: {
            algorithm: null,
            signature: null
        }

    });

    //xx    request.requestHeader.authenticationToken = session.authenticationToken;

    var self  = this;
    session.performMessageTransaction(request, function(err,response){

        if (!err) {

            assert( response instanceof s.ActivateSessionResponse);

            session.serverNonce = response.serverNonce;

            var results = response.results;

            callback(null,session);

        } else {

            callback(err,null);
        }
    });
};

/**
 * create and activate a new session
 *
 * @param callback
 */
OPCUAClient.prototype.createSession = function(callback) {

    assert(_.isFunction(callback));
    var self = this;

    self._createSession(function(err,session){
        if(err) {
            callback(err);
        } else {
            self._activateSession(session,function(err){
                assert(!_.contains(self._sessions,session));
                if (!err) {
                    self._sessions.push(session);
                    assert(_.contains(self._sessions,session));

                } else {
                    console.log(" Client _activateSession  has failed");
                }
                callback(err,session);
            });
        }
    });

};

OPCUAClient.prototype._closeSession= function(session,callback) {

    assert(_.isFunction(callback));
    assert(session);
    assert(_.contains(this._sessions,session));

    if (!this._secureChannel) {
        callback(new Error(" No secure channel"));
    }

    var request = new s.CloseSessionRequest({
        deleteSubscriptions: true
    });

    var self  = this;
    session.performMessageTransaction(request, function(err,response){

        if(err) {
            console.log(" received : ",err);
            self._secureChannel.close(function(){
                callback(err,null);
            });
        } else {
            //xx s.CloseSessionResponse
            self._secureChannel.close(callback);
        }
    });
};

/**
 * @param callback
 * @param session
 */
OPCUAClient.prototype.closeSession = function(session,callback) {
    assert(_.isFunction(callback));
    assert(session);
    assert(_.contains(this._sessions,session));

    var self = this;
    //todo : send close session on secure channel
    self._closeSession(session,function(err){
        var index = self._sessions.indexOf(session);
        if (index >=0 ) {
            self._sessions.splice(index, 1);
        }
        callback(err);
    });
};



exports.OPCUAClient = OPCUAClient;
